package commandcode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/MichaelKinsy/PiG/ai"
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

type transportRouter struct {
	mu         sync.Mutex
	key, route string
	base       string
	client     *http.Client
	headers    map[string]string
}

func (r *transportRouter) requestHeaders(request ai.ProviderHeaders) ai.ProviderHeaders {
	merged := ai.ProviderHeadersFromStrings(r.headers)
	if merged == nil {
		merged = ai.ProviderHeaders{}
	}
	for name, value := range request {
		for existing := range merged {
			if strings.EqualFold(existing, name) {
				delete(merged, existing)
			}
		}
		merged[name] = value
	}
	return merged
}

func (r *transportRouter) status() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.route == "" {
		return "unknown"
	}
	return r.route
}
func (r *transportRouter) selectRoute(key string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if key != r.key {
		r.key = key
		r.route = ""
	}
	return r.route
}
func (r *transportRouter) remember(key, route string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if key == r.key {
		r.route = route
	}
}

type upgradeTransport struct {
	parent  http.RoundTripper
	upgrade atomic.Bool
}

func (t *upgradeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := t.parent.RoundTrip(req)
	if err != nil || res.StatusCode != http.StatusForbidden {
		return res, err
	}
	// Restore every consumed byte, including oversized/non-JSON errors. Only the
	// exact upgrade code authorizes fallback; no substring or generic 403 match.
	prefix, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		res.Body.Close()
		return nil, err
	}
	res.Body = &restoredBody{Reader: io.MultiReader(bytes.NewReader(prefix), res.Body), closer: res.Body}
	var body struct {
		Code  string `json:"code"`
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(prefix, &body) == nil {
		code := body.Code
		if body.Error != nil {
			code = body.Error.Code
		}
		t.upgrade.Store(code == "upgrade_required")
	}
	return res, nil
}

type restoredBody struct {
	io.Reader
	closer io.Closer
}

func (b *restoredBody) Close() error { return b.closer.Close() }

func nativeModel(wire map[string]any) (*ai.Model, error) {
	wire = maps.Clone(wire)
	wire["provider"] = providerID
	if compat, ok := wire["compatConfig"]; ok {
		wire["compat"] = compat
	}
	if strings.HasPrefix(stringField(wire, "id"), "claude-") {
		wire["api"] = string(ai.APIAnthropicMessages)
	} else {
		wire["api"] = string(ai.APIOpenAICompletions)
	}
	data, err := json.Marshal(wire)
	if err != nil {
		return nil, err
	}
	models, err := ai.DecodeModelsCatalog([]json.RawMessage{data}, providerID)
	if err != nil {
		return nil, err
	}
	if len(models) != 1 {
		return nil, errors.New("expected one chat model")
	}
	model, ok := models[0].(*ai.Model)
	if !ok {
		return nil, errors.New("unsupported model type")
	}
	return model, nil
}

func streamOptions(options sdk.ProviderStreamOptions) (ai.StreamOptions, error) {
	// JSON tags on the public options preserve raw effort, retries, budgets,
	// headers, sampling, session affinity, and explicit zero values.
	data, err := json.Marshal(options.Values)
	if err != nil {
		return ai.StreamOptions{}, err
	}
	var result ai.StreamOptions
	if err = json.Unmarshal(data, &result); err != nil {
		return result, err
	}
	_, result.TemperatureSet = options.Values["temperature"]
	return result, nil
}

func (r *transportRouter) stream(wire, request map[string]any, options sdk.ProviderStreamOptions) (*sdk.ModelEventStream, error) {
	out := sdk.CreateAssistantMessageEventStream()
	go func() {
		ctx := options.Signal
		if ctx == nil {
			ctx = context.Background()
		}
		key := usableKey(stringField(options.Values, "apiKey"))
		if key == "" {
			var err error
			key, _, err = resolveKey(sdk.APIKeyAuthInput{})
			if err != nil {
				pushFailure(out, wire, ctx, key, err)
				return
			}
		}
		if key == "" {
			pushFailure(out, wire, ctx, key, errors.New("No Command Code API key. Run /login or set COMMAND_CODE_API_KEY"))
			return
		}
		transcript, err := decodeTranscript(request)
		if err != nil {
			pushFailure(out, wire, ctx, key, err)
			return
		}
		model, err := nativeModel(wire)
		if err != nil {
			pushFailure(out, wire, ctx, key, err)
			return
		}
		if r.selectRoute(key) == "generate" {
			r.generate(ctx, out, wire, transcript, options, key)
			return
		}
		opts, err := streamOptions(options)
		if err != nil {
			pushFailure(out, wire, ctx, key, err)
			return
		}
		parent := r.client.Transport
		if parent == nil {
			parent = http.DefaultTransport
		}
		intercept := &upgradeTransport{parent: parent}
		client := *r.client
		client.Transport = intercept
		opts.Headers = r.requestHeaders(opts.Headers)
		opts.APIKey = key
		opts.Fetch = &client
		if options.OnPayload != nil {
			opts.OnPayload = func(payload any, _ *ai.Model) (any, error) { return options.OnPayload(payload, wire) }
		}
		if options.OnResponse != nil {
			opts.OnResponse = func(_ context.Context, response ai.ProviderResponse, _ *ai.Model) error {
				if intercept.upgrade.Load() {
					return nil
				}
				return options.OnResponse(map[string]any{"status": response.Status, "headers": response.Headers}, wire)
			}
		}
		if options.OnProviderStreamEvent != nil {
			opts.OnProviderStreamEvent = func(_ context.Context, data any, _ *ai.Model) error {
				return options.OnProviderStreamEvent(data, wire)
			}
		}
		inner, err := ai.StreamSimple(ctx, model, providerTranscript(transcript, model), opts)
		if err != nil {
			pushFailure(out, wire, ctx, key, err)
			return
		}
		terminal := false
		// Drain with a non-cancelled consumer context: the producer must publish
		// its one aborted terminal event, not strand the SDK result on cancellation.
		for event := range inner.Events(context.Background()) {
			if intercept.upgrade.Load() {
				continue
			}
			value, err := eventMap(event)
			if err != nil {
				pushFailure(out, wire, ctx, key, err)
				return
			}
			r.remember(key, "provider")
			normalizeEvent(value, key)
			out.Push(value)
			kind := stringField(value, "type")
			terminal = terminal || kind == "done" || kind == "error"
		}
		if intercept.upgrade.Load() {
			r.remember(key, "generate")
			r.generate(ctx, out, wire, transcript, options, key)
			return
		}
		if !terminal {
			pushFailure(out, wire, ctx, key, errors.New("provider stream ended without terminal event"))
		}
	}()
	return out, nil
}

func eventMap(event any) (map[string]any, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	err = json.Unmarshal(data, &value)
	return value, err
}

var bearerPattern = regexp.MustCompile(`(?i)bearer\s+[^\s"'<>]+`)
var overflowPattern = regexp.MustCompile(`(?i)(\b(?:context[_ -]*(?:length|window)|model[_ -]*context[_ -]*window)[_ -]*(?:exceeded|overflow(?:ed)?|too[_ -]*(?:large|long))\b|\b(?:context|prompt|input)[_ -]*(?:length|window|size|tokens?|limit|maximum)\b.{0,120}\b(?:exceed(?:ed|s)?|overflow(?:ed|s)?|too\s+(?:large|long)|(?:maximum|limit)\s+(?:reached|exceeded|hit))\b|\b(?:prompt|input|context)\b.{0,32}\btoo\s+(?:large|long)\b|\b(?:prompt|input)[_ -]*too[_ -]*(?:large|long)\b|\b(?:prompt|input)[_ -]*tokens?[_ -]*(?:limit|maximum|max)[_ -]*(?:exceeded|reached)\b|\b(?:maximum|limit)[_ -]+(?:allowed[_ -]+)?(?:context|prompt|input)[_ -]*(?:length|window|size|tokens?)\b|\bcontext[_ -]*overflow\b)`)
var nonOverflowPattern = regexp.MustCompile(`(?i)(\brate[_ -]*limit\b|\btoo\s+many\s+requests\b|\b(?:capacity|quota|throttl(?:e|ed|ing)?|concurren(?:cy|t)|overloaded)\b|\b(?:service|temporarily)\s+unavailable\b|(?:api\s+error|http|status(?:[_ -]*code)?)\s*[:(=]?\s*429\b|"status(?:Code)?"\s*:\s*429)`)
var credentialPattern = regexp.MustCompile(`(?i)((?:api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|authorization)["']?\s*[=:]\s*["']?)[^\s,"';)&<>]+`)
var standaloneSecretPattern = regexp.MustCompile(`(?i)\b(?:user|cc)_[A-Za-z0-9_-]{8,}\b|\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}\b|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)

func safeError(message, key string) string {
	if key != "" {
		message = strings.ReplaceAll(message, key, "[redacted]")
	}
	message = bearerPattern.ReplaceAllString(message, "Bearer [redacted]")
	message = credentialPattern.ReplaceAllString(message, "${1}[redacted]")
	message = standaloneSecretPattern.ReplaceAllString(message, "[redacted]")
	if !strings.Contains(strings.ToLower(message), "context_length_exceeded") && !nonOverflowPattern.MatchString(message) && overflowPattern.MatchString(message) {
		return "context_length_exceeded: " + message
	}
	return message
}

func normalizeEvent(event map[string]any, key string) {
	for _, field := range []string{"partial", "message", "error"} {
		if message, ok := event[field].(map[string]any); ok {
			message["api"] = customAPI
			message["provider"] = providerID
			if text := stringField(message, "errorMessage"); text != "" {
				message["errorMessage"] = safeError(text, key)
			}
		}
	}
}

func emptyMessage(model map[string]any) map[string]any {
	return map[string]any{"role": "assistant", "api": customAPI, "provider": providerID, "model": stringField(model, "id"), "content": []any{}, "stopReason": "stop", "timestamp": time.Now().UnixMilli(), "usage": map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}}
}

func pushFailure(out *sdk.ModelEventStream, model map[string]any, ctx context.Context, key string, err error) {
	reason := "error"
	if ctx.Err() != nil {
		reason = "aborted"
	}
	message := emptyMessage(model)
	message["stopReason"] = reason
	message["errorMessage"] = safeError(fmt.Sprint(err), key)
	out.Push(map[string]any{"type": "error", "reason": reason, "error": message})
}
