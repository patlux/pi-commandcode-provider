package commandcode

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/MichaelKinsy/PiG/ai"
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func (r *transportRouter) generate(ctx context.Context, out *sdk.ModelEventStream, wire map[string]any, transcript ai.TranscriptContext, options sdk.ProviderStreamOptions, key string) {
	model, err := nativeModel(wire)
	if err != nil {
		pushFailure(out, wire, ctx, key, err)
		return
	}
	opts, err := streamOptions(options)
	if err != nil {
		pushFailure(out, wire, ctx, key, err)
		return
	}
	payload, err := generatePayload(model, transcript, opts)
	if err != nil {
		pushFailure(out, wire, ctx, key, err)
		return
	}
	var body any = payload
	if options.OnPayload != nil {
		body, err = options.OnPayload(payload, wire)
		if err != nil {
			pushFailure(out, wire, ctx, key, err)
			return
		}
		if body == nil {
			body = payload
		}
	}
	data, err := json.Marshal(body)
	if err != nil {
		pushFailure(out, wire, ctx, key, err)
		return
	}
	state := newGenerateState(out, wire, model)
	state.emit("start", nil)
	if err = r.consumeGenerate(ctx, state, data, opts, options, wire, key); err != nil {
		reason := "error"
		if ctx.Err() != nil || errors.Is(err, context.Canceled) {
			reason = "aborted"
		}
		state.message["stopReason"] = reason
		state.message["errorMessage"] = safeError(err.Error(), key)
		state.publish(map[string]any{"type": "error", "reason": reason, "error": state.message})
		return
	}
	state.endBlock()
	state.publish(map[string]any{"type": "done", "reason": state.message["stopReason"], "message": state.message})
}

func (r *transportRouter) consumeGenerate(ctx context.Context, state *generateState, data []byte, opts ai.StreamOptions, callbacks sdk.ProviderStreamOptions, wire map[string]any, key string) error {
	retries := 0
	if opts.MaxRetries != nil {
		retries = max(0, *opts.MaxRetries)
	}
	for attempt := 0; ; attempt++ {
		requestCtx, cancel := context.WithCancel(ctx)
		var timer *time.Timer
		var timedOut atomic.Bool
		if opts.TimeoutMs != nil && *opts.TimeoutMs > 0 {
			timer = time.AfterFunc(time.Duration(*opts.TimeoutMs)*time.Millisecond, func() { timedOut.Store(true); cancel() })
		}
		cleanup := func() {
			if timer != nil {
				timer.Stop()
			}
			cancel()
		}
		req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, strings.TrimSuffix(strings.TrimRight(r.base, "/"), "/provider/v1")+"/alpha/generate", bytes.NewReader(data))
		if err != nil {
			cleanup()
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("x-command-code-version", catalog.CLIVersion)
		req.Header.Set("x-cli-environment", "production")
		req.Header.Set("x-taste-learning", "true")
		req.Header.Set("User-Agent", "cli")
		cwd, _ := os.Getwd()
		req.Header.Set("x-project-slug", projectSlug(cwd))
		if opts.SessionID != "" {
			req.Header.Set("x-session-id", opts.SessionID)
		}
		for name, value := range r.requestHeaders(opts.Headers) {
			if value == nil {
				req.Header.Del(name)
			} else {
				req.Header.Set(name, *value)
			}
		}
		res, err := r.client.Do(req)
		if err != nil {
			cleanup()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errors.New("Command Code generate request failed or timed out")
		}
		if (res.StatusCode == 429 || (res.StatusCode >= 500 && res.StatusCode < 600)) && attempt < retries {
			res.Body.Close()
			cleanup()
			delay, err := generateRetryDelay(attempt, res.Header.Get("Retry-After"), opts.MaxRetryDelayMs, time.Now())
			if err != nil {
				return err
			}
			wait := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				wait.Stop()
				return ctx.Err()
			case <-wait.C:
				continue
			}
		}
		if callbacks.OnResponse != nil {
			headers := map[string]string{}
			for name := range res.Header {
				headers[strings.ToLower(name)] = res.Header.Get(name)
			}
			if err = callbacks.OnResponse(map[string]any{"status": res.StatusCode, "headers": headers}, wire); err != nil {
				res.Body.Close()
				cleanup()
				return err
			}
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
			res.Body.Close()
			cleanup()
			return fmt.Errorf("Command Code API error %d: %s", res.StatusCode, safeError(string(body), key))
		}
		var reader io.Reader = res.Body
		if timer != nil {
			reader = &idleProgressReader{Reader: reader, timer: timer, timeout: time.Duration(*opts.TimeoutMs) * time.Millisecond}
		}
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 4096), 4<<20)
		finished := false
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if strings.HasPrefix(line, "data:") {
				line = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			}
			if line == "" || line == "[DONE]" || strings.HasPrefix(line, ":") || strings.HasPrefix(line, "event:") {
				continue
			}
			var event map[string]any
			if json.Unmarshal([]byte(line), &event) != nil {
				continue
			}
			if callbacks.OnProviderStreamEvent != nil {
				if err = callbacks.OnProviderStreamEvent(event, wire); err != nil {
					break
				}
			}
			finished, err = state.handle(event)
			if err != nil || finished {
				break
			}
		}
		if err == nil {
			err = scanner.Err()
		}
		res.Body.Close()
		cleanup()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if timedOut.Load() && !finished {
			return errors.New("Command Code generate stream timed out")
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		if !finished {
			return errors.New("Stream ended unexpectedly before completion (no finish event)")
		}
		return nil
	}
}

// Track transport progress, not decoded events: a single JSON line may arrive
// over many reads. A stalled partial line must still expire.
type idleProgressReader struct {
	io.Reader
	timer   *time.Timer
	timeout time.Duration
}

func (r *idleProgressReader) Read(buffer []byte) (int, error) {
	n, err := r.Reader.Read(buffer)
	if n > 0 {
		r.timer.Reset(r.timeout)
	}
	return n, err
}

func generateRetryDelay(attempt int, header string, capMs *int, now time.Time) (time.Duration, error) {
	limit := time.Minute
	if capMs != nil {
		limit = time.Duration(math.MaxInt64)
		if *capMs > 0 && int64(*capMs) < math.MaxInt64/int64(time.Millisecond) {
			limit = time.Duration(*capMs) * time.Millisecond
		}
	}
	delay := time.Duration(500*(1<<min(attempt, 7))) * time.Millisecond
	serverDelay := false
	header = strings.TrimSpace(header)
	if seconds, err := strconv.ParseFloat(header, 64); err == nil && seconds >= 0 && !math.IsInf(seconds, 0) {
		serverDelay = true
		// Saturate before converting to Duration; overflow could otherwise turn
		// a very long Retry-After into an immediate retry.
		delay = time.Duration(math.MaxInt64)
		if seconds < float64(math.MaxInt64)/float64(time.Second) {
			delay = time.Duration(seconds * float64(time.Second))
		}
	} else if date, err := http.ParseTime(header); err == nil {
		serverDelay = true
		delay = max(0, date.Sub(now))
	}
	if serverDelay && delay > limit {
		return 0, errors.New("Retry-After exceeds maximum retry delay")
	}
	return min(delay, limit), nil
}

// Partial JSON parsing is for progress only. A terminal tool call must contain
// a complete object, never silently repaired/truncated arguments or null.
func finalToolArguments(value any) (map[string]any, error) {
	var args map[string]any
	switch value := value.(type) {
	case map[string]any:
		args = value
	case string:
		if err := json.Unmarshal([]byte(value), &args); err != nil {
			return nil, errors.New("invalid tool call arguments: expected a complete JSON object")
		}
	}
	if args == nil {
		return nil, errors.New("invalid tool call arguments: expected a complete JSON object")
	}
	return args, nil
}

type activeTool struct {
	index     int
	block     map[string]any
	arguments string
}
type generateState struct {
	out       *sdk.ModelEventStream
	message   map[string]any
	content   []any
	index     int
	kind      string
	tools     map[string]*activeTool
	completed map[string]bool
	model     *ai.Model
}

func newGenerateState(out *sdk.ModelEventStream, wire map[string]any, model *ai.Model) *generateState {
	return &generateState{out: out, message: emptyMessage(wire), content: []any{}, index: -1, tools: map[string]*activeTool{}, completed: map[string]bool{}, model: model}
}
func (s *generateState) publish(event map[string]any) {
	snapshot, err := eventMap(event)
	if err != nil {
		panic("non-JSON internal generate event")
	}
	s.out.Push(snapshot)
}
func (s *generateState) emit(kind string, fields map[string]any) {
	event := map[string]any{"type": kind, "partial": s.message}
	for key, value := range fields {
		event[key] = value
	}
	s.publish(event)
}
func (s *generateState) append(block map[string]any) int {
	s.content = append(s.content, block)
	s.message["content"] = s.content
	return len(s.content) - 1
}
func (s *generateState) endBlock() {
	if s.index < 0 {
		return
	}
	block := s.content[s.index].(map[string]any)
	field := "text"
	if s.kind == "thinking" {
		field = "thinking"
	}
	s.emit(s.kind+"_end", map[string]any{"contentIndex": s.index, "content": block[field]})
	s.index = -1
	s.kind = ""
}
func (s *generateState) delta(kind, delta string) {
	if kind != s.kind {
		s.endBlock()
		s.kind = kind
		s.index = s.append(map[string]any{"type": kind, kind: ""})
		s.emit(kind+"_start", map[string]any{"contentIndex": s.index})
	}
	block := s.content[s.index].(map[string]any)
	block[kind] = stringField(block, kind) + delta
	s.emit(kind+"_delta", map[string]any{"contentIndex": s.index, "delta": delta})
}

func (s *generateState) handle(event map[string]any) (bool, error) {
	switch stringField(event, "type") {
	case "text-delta":
		s.delta("text", stringField(event, "text"))
	case "reasoning-start":
		s.endBlock()
	case "reasoning-delta":
		s.delta("thinking", stringField(event, "text"))
	case "reasoning-end":
		s.endBlock()
	case "tool-input-start":
		s.endBlock()
		id := stringField(event, "id")
		if id == "" || s.tools[id] != nil || s.completed[id] {
			break
		}
		block := map[string]any{"type": "toolCall", "id": id, "name": stringField(event, "toolName"), "arguments": map[string]any{}}
		index := s.append(block)
		s.tools[id] = &activeTool{index: index, block: block}
		s.emit("toolcall_start", map[string]any{"contentIndex": index})
	case "tool-input-delta":
		tool := s.tools[stringField(event, "id")]
		if tool == nil {
			break
		}
		delta := stringField(event, "delta")
		tool.arguments += delta
		tool.block["arguments"] = ai.ParseStreamingJson(tool.arguments)
		s.emit("toolcall_delta", map[string]any{"contentIndex": tool.index, "delta": delta})
	case "tool-call":
		s.endBlock()
		id := stringField(event, "toolCallId")
		if strings.TrimSpace(id) == "" {
			return false, errors.New("tool call missing ID")
		}
		if s.completed[id] {
			break
		}
		tool := s.tools[id]
		name := stringField(event, "toolName")
		var input any
		if tool != nil {
			input = tool.arguments
			if name == "" {
				name = stringField(tool.block, "name")
			}
		}
		if strings.TrimSpace(name) == "" {
			return false, errors.New("tool call missing name")
		}
		for _, field := range []string{"input", "args", "arguments"} {
			if value, ok := event[field]; ok {
				input = value
				break
			}
		}
		args, err := finalToolArguments(input)
		if err != nil {
			return false, err
		}
		if tool == nil {
			block := map[string]any{"type": "toolCall", "id": id, "name": name, "arguments": map[string]any{}}
			tool = &activeTool{index: s.append(block), block: block}
			s.emit("toolcall_start", map[string]any{"contentIndex": tool.index})
		}
		tool.block["name"] = name
		tool.block["arguments"] = args
		s.emit("toolcall_end", map[string]any{"contentIndex": tool.index, "toolCall": tool.block})
		delete(s.tools, id)
		s.completed[id] = true
	case "finish":
		raw := strings.ToLower(strings.NewReplacer("_", "", "-", "", " ", "").Replace(stringField(event, "rawFinishReason")))
		if raw == "networkerror" || raw == "connectionerror" || raw == "upstreamerror" {
			return false, errors.New("upstream connection failed mid-stream")
		}
		if len(s.tools) > 0 {
			return false, errors.New("stream finished with incomplete tool arguments")
		}
		usage, _ := event["totalUsage"].(map[string]any)
		if usage == nil {
			usage, _ = event["usage"].(map[string]any)
		}
		if usage != nil {
			s.setUsage(usage)
		}
		reason := "stop"
		switch stringField(event, "finishReason") {
		case "tool-calls":
			reason = "toolUse"
		case "length", "max_tokens", "max-tokens", "max_output_tokens":
			reason = "length"
		}
		s.message["stopReason"] = reason
		return true, nil
	case "abort":
		return false, context.Canceled
	case "error":
		for _, field := range []string{"error", "message"} {
			if value, ok := event[field]; ok {
				if text, ok := value.(string); ok {
					return false, errors.New(text)
				}
				data, _ := json.Marshal(value)
				return false, errors.New(string(data))
			}
		}
		return false, errors.New("Command Code stream error")
	}
	return false, nil
}

func numeric(value any) float64 { number, _ := value.(float64); return number }
func (s *generateState) setUsage(usage map[string]any) {
	details, _ := usage["inputTokenDetails"].(map[string]any)
	if details == nil {
		details, _ = usage["inputTokensDetails"].(map[string]any)
	}
	read, write := numeric(details["cacheReadTokens"]), numeric(details["cacheWriteTokens"])
	input := max(0, numeric(usage["inputTokens"])-read-write)
	if value, ok := details["noCacheTokens"]; ok {
		input = numeric(value)
	}
	output := numeric(usage["outputTokens"])
	rates := s.model.CostRates()
	for _, tier := range rates.Tiers {
		if input+read+write > float64(tier.InputTokensAbove) {
			rates.Input = tier.InputCostPer1M
			rates.Output = tier.OutputCostPer1M
			rates.CacheRead = tier.CacheReadCostPer1M
			rates.CacheWrite = tier.CacheWriteCostPer1M
		}
	}
	cost := map[string]any{"input": input * rates.Input / 1e6, "output": output * rates.Output / 1e6, "cacheRead": read * rates.CacheRead / 1e6, "cacheWrite": write * rates.CacheWrite / 1e6}
	cost["total"] = numeric(cost["input"]) + numeric(cost["output"]) + numeric(cost["cacheRead"]) + numeric(cost["cacheWrite"])
	s.message["usage"] = map[string]any{"input": input, "output": output, "cacheRead": read, "cacheWrite": write, "totalTokens": input + output + read + write, "cost": cost}
}
