package commandcode

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MichaelKinsy/PiG/ai"
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func testModel() map[string]any {
	return (modelEntry{ID: "gpt-4.1", Name: "GPT", ContextWindow: 128000}).wire(defaultBase)
}
func testRequest() map[string]any {
	return map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hello"}}}
}
func collect(t *testing.T, stream *sdk.ModelEventStream) []map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events := []map[string]any{}
	for event := range stream.Events(ctx) {
		events = append(events, event)
	}
	if ctx.Err() != nil {
		t.Fatal("stream never terminated")
	}
	terminal := 0
	for _, event := range events {
		if event["type"] == "done" || event["type"] == "error" {
			terminal++
		}
	}
	if terminal != 1 {
		t.Fatalf("expected exactly one terminal event: %#v", events)
	}
	return events
}

func TestUpgradeDetectionIsExactAndPreservesBody(t *testing.T) {
	for _, test := range []struct {
		name, body string
		status     int
		want       bool
	}{
		{"nested", `{"error":{"code":"upgrade_required"}}`, 403, true},
		{"top", `{"code":"upgrade_required"}`, 403, true},
		{"status", `{"error":{"code":"upgrade_required"}}`, 401, false},
		{"message", `{"error":{"message":"upgrade_required"}}`, 403, false},
		{"other", `{"error":{"code":"forbidden"}}`, 403, false},
		{"invalid", `upgrade_required`, 403, false},
		{"oversized", strings.Repeat("x", (1<<20)+10), 403, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			transport := &upgradeTransport{parent: ai.FetchFunction(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: test.status, Body: io.NopCloser(strings.NewReader(test.body))}, nil
			})}
			req, _ := http.NewRequest(http.MethodPost, "https://example.invalid", nil)
			res, err := transport.RoundTrip(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			body, err := io.ReadAll(res.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(body) != test.body {
				t.Fatal("interception changed error body")
			}
			if transport.upgrade.Load() != test.want {
				t.Fatalf("upgrade=%v want %v", transport.upgrade.Load(), test.want)
			}
		})
	}
}

func TestTransportDoesNotFallbackForOtherFailures(t *testing.T) {
	for _, status := range []int{400, 401, 403, 429, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var generate atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/alpha/generate" {
					generate.Add(1)
				}
				w.WriteHeader(status)
				fmt.Fprint(w, `{"error":{"code":"not_allowed","message":"Bearer synthetic-private-key"}}`) // gitleaks:allow -- synthetic redaction regression fixture
			}))
			defer server.Close()
			model := testModel()
			model["baseUrl"] = server.URL + "/provider/v1"
			router := &transportRouter{base: server.URL + "/provider/v1", client: server.Client()}
			stream, err := router.stream(model, testRequest(), sdk.ProviderStreamOptions{Values: map[string]any{"apiKey": "synthetic-private-key", "maxRetries": 0}})
			if err != nil {
				t.Fatal(err)
			}
			events := collect(t, stream)
			if events[len(events)-1]["type"] != "error" {
				t.Fatalf("unexpected success: %#v", events)
			}
			data, _ := json.Marshal(events)
			if strings.Contains(string(data), "synthetic-private-key") {
				t.Fatal("secret in error")
			}
			if generate.Load() != 0 {
				t.Fatal("non-upgrade error triggered fallback")
			}
		})
	}
}

func TestRouteMemoryDoesNotCrossCredentialChanges(t *testing.T) {
	router := &transportRouter{}
	router.selectRoute("key-a")
	router.remember("key-a", "generate")
	if router.selectRoute("key-a") != "generate" {
		t.Fatal("route was not remembered")
	}
	if router.selectRoute("key-b") != "" {
		t.Fatal("route crossed credential boundary")
	}
	router.remember("key-a", "generate")
	if router.status() != "unknown" {
		t.Fatal("stale in-flight request changed newer route")
	}
}

func TestPublicOptionMapping(t *testing.T) {
	opts, err := streamOptions(sdk.ProviderStreamOptions{Values: map[string]any{"temperature": 0, "apiKey": "test", "maxTokens": 123, "sessionId": "session", "reasoning": "high", "maxRetries": 0, "maxRetryDelayMs": 1200, "timeoutMs": 500, "headers": map[string]any{"x-test": "value", "remove": nil}}})
	if err != nil {
		t.Fatal(err)
	}
	if !opts.TemperatureSet || opts.Temperature != 0 || opts.APIKey != "test" || opts.MaxTokens != 123 || opts.SessionID != "session" || opts.Thinking != ai.ThinkingHigh || opts.MaxRetries == nil || *opts.MaxRetries != 0 || opts.TimeoutMs == nil || *opts.TimeoutMs != 500 || opts.MaxRetryDelayMs == nil || *opts.MaxRetryDelayMs != 1200 || opts.Headers["x-test"] == nil || *opts.Headers["x-test"] != "value" {
		t.Fatalf("lost option: %#v", opts)
	}
}

func TestTranscriptKeepsSystemSectionsToolsAndSignedThinking(t *testing.T) {
	request := map[string]any{"messages": []any{
		map[string]any{"role": "system", "content": []any{map[string]any{"type": "text", "text": "initial"}}, "sections": map[string]any{"policy": "keep me"}, "toolsAdded": []any{map[string]any{"name": "lookup", "description": "lookup", "parameters": map[string]any{"type": "object"}}}},
		map[string]any{"role": "user", "content": []any{map[string]any{"type": "image", "mimeType": "image/png", "data": "aGVsbG8="}}},
		map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "thinking", "thinking": "thought", "thinkingSignature": "signature"}, map[string]any{"type": "toolCall", "id": "call-1", "name": "lookup", "arguments": map[string]any{"a": 1}}}, "api": customAPI, "provider": providerID, "model": "gpt-4.1", "stopReason": "toolUse"},
		map[string]any{"role": "toolResult", "toolCallId": "call-1", "toolName": "lookup", "content": []any{map[string]any{"type": "text", "text": "result"}}},
	}}
	transcript, err := decodeTranscript(request)
	if err != nil {
		t.Fatal(err)
	}
	messages := transcript.Messages()
	if len(messages) != 4 {
		t.Fatalf("lost transcript: %#v", messages)
	}
	if !strings.Contains(ai.GetCurrentSystemPrompt(messages), "keep me") || len(ai.GetCurrentTools(messages)) != 1 {
		t.Fatal("lost prompt or tools")
	}
	assistant := messages[2].(ai.AssistantMessage)
	if assistant.Content[0].(ai.ThinkingContent).ThinkingSignature != "signature" {
		t.Fatal("lost reasoning signature")
	}
}

func TestNativeTransportReplaysSignedThinking(t *testing.T) {
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		w.WriteHeader(400)
		fmt.Fprint(w, `{"error":{"message":"end test"}}`)
	}))
	defer server.Close()
	model := (modelEntry{ID: "claude-sonnet-4-6", Name: "Claude", ContextWindow: 200000}).wire(server.URL + "/provider/v1")
	request := map[string]any{"messages": []any{
		map[string]any{"role": "user", "content": "first"},
		map[string]any{"role": "assistant", "api": customAPI, "provider": providerID, "model": "claude-sonnet-4-6", "stopReason": "stop", "content": []any{map[string]any{"type": "thinking", "thinking": "signed thought", "thinkingSignature": "signature"}, map[string]any{"type": "text", "text": "answer"}}},
		map[string]any{"role": "user", "content": "second"},
	}}
	router := &transportRouter{base: server.URL + "/provider/v1", client: server.Client()}
	stream, err := router.stream(model, request, sdk.ProviderStreamOptions{Values: map[string]any{"apiKey": "synthetic", "reasoning": "high", "maxRetries": 0}})
	if err != nil {
		t.Fatal(err)
	}
	collect(t, stream)
	data, _ := json.Marshal(payload)
	if !strings.Contains(string(data), `"signature":"signature"`) {
		t.Fatalf("signed reasoning lost on second turn: %s", data)
	}
}

func TestModelsColdCacheOfflineAndInvalidResponse(t *testing.T) {
	var failed atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("catalog must be public")
		}
		if failed.Load() {
			http.Error(w, "unavailable", 503)
			return
		}
		fmt.Fprint(w, `{"object":"list","data":[{"id":"gpt-4.1","name":"GPT","context_length":128000}]}`)
	}))
	defer server.Close()
	store := &modelStore{base: defaultBase, endpoint: server.URL, cachePath: filepath.Join(t.TempDir(), "cache.json"), client: server.Client(), timeout: time.Second}
	if err := store.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	models, _ := store.get()
	if len(models) != 1 || store.source != "live" {
		t.Fatal("cold catalog not loaded")
	}
	file, err := os.Stat(store.cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if file.Mode().Perm() != 0600 {
		t.Fatal("cache permissions")
	}
	failed.Store(true)
	if err := store.refresh(context.Background()); err == nil {
		t.Fatal("expected network failure")
	}
	models, _ = store.get()
	if len(models) != 1 || store.source != "live" {
		t.Fatal("failed refresh did not retain the last live catalog")
	}
	store.cachePath = filepath.Join(t.TempDir(), "absent.json")
	_ = store.refresh(context.Background())
	models, _ = store.get()
	if len(models) != 1 {
		t.Fatal("failed refresh discarded last known good catalog")
	}
}

func TestModelSnapshotsDoNotAliasCatalog(t *testing.T) {
	entry := modelEntry{ID: "gpt-5.4", Name: "GPT", ContextWindow: 128000}
	first := entry.wire(defaultBase)
	first["input"].([]string)[0] = "corrupted"
	first["cost"].(map[string]any)["input"] = -1.0
	second := entry.wire(defaultBase)
	if second["input"].([]string)[0] != "text" || second["cost"].(map[string]any)["input"] == -1.0 {
		t.Fatal("caller mutated authoritative catalog")
	}
}

func TestRefreshCoalesces(t *testing.T) {
	var requests atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			close(entered)
		}
		<-release
		fmt.Fprint(w, `{"object":"list","data":[{"id":"gpt-4.1","name":"GPT","context_length":128000}]}`)
	}))
	defer server.Close()
	store := &modelStore{base: defaultBase, endpoint: server.URL, cachePath: filepath.Join(t.TempDir(), "cache.json"), client: server.Client(), timeout: time.Second}
	var group sync.WaitGroup
	group.Go(func() {
		if err := store.refresh(context.Background()); err != nil {
			t.Error(err)
		}
	})
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := store.refresh(ctx); err != context.Canceled {
		t.Errorf("waiting cancellation: %v", err)
	}
	close(release)
	group.Wait()
	if requests.Load() != 1 {
		t.Fatalf("requests=%d", requests.Load())
	}
}

func TestAuthPrecedenceAndActualLoginValidation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("COMMAND_CODE_API_KEY", "env-primary")
	t.Setenv("COMMANDCODE_API_KEY", "env-legacy")
	key, _, err := resolveKey(sdk.APIKeyAuthInput{Credential: map[string]any{"key": "host-key"}})
	if err != nil || key != "host-key" {
		t.Fatal("host credential precedence")
	}
	key, _, _ = resolveKey(sdk.APIKeyAuthInput{})
	if key != "env-primary" {
		t.Fatal("primary environment precedence")
	}
	t.Setenv("COMMAND_CODE_API_KEY", "$COMMAND_CODE_API_KEY")
	key, _, _ = resolveKey(sdk.APIKeyAuthInput{})
	if key != "env-legacy" {
		t.Fatal("placeholder not ignored")
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/alpha/whoami" || r.Header.Get("Authorization") != "Bearer pasted-key" {
			t.Error("incorrect validation request")
		}
		fmt.Fprint(w, `{}`)
	}))
	defer server.Close()
	credential, err := keyAuth(server.URL+"/provider/v1", server.Client()).Login(sdk.AuthInteraction{Prompt: func(map[string]any) (string, error) { return "\x1b[200~pasted-key\x1b[201~\n", nil }})
	if err != nil {
		t.Fatal(err)
	}
	if credential["key"] != "pasted-key" || calls.Load() != 1 {
		t.Fatal("login did not validate actual entered key")
	}
}

func TestConfiguredHeaderOverrideIsCaseInsensitive(t *testing.T) {
	router := &transportRouter{headers: map[string]string{"x-cmd-zdr": "1"}}
	merged := router.requestHeaders(ai.ProviderHeaders{"X-Cmd-Zdr": nil, "x-extra": ai.ProviderHeader("value")})
	if len(merged) != 2 || merged["X-Cmd-Zdr"] != nil || merged["x-extra"] == nil {
		t.Fatalf("wrong overrides: %#v", merged)
	}
	if _, present := merged["x-cmd-zdr"]; present {
		t.Fatal("case variant retained configured header")
	}
	if router.headers["x-cmd-zdr"] != "1" {
		t.Fatal("request mutated provider headers")
	}
}

func TestGenerateRepeatedToolCompletionDoesNotDuplicateCall(t *testing.T) {
	wire := testModel()
	model, err := nativeModel(wire)
	if err != nil {
		t.Fatal(err)
	}
	out := sdk.CreateAssistantMessageEventStream()
	state := newGenerateState(out, wire, model)
	start := map[string]any{"type": "tool-input-start", "id": "one", "toolName": "lookup"}
	end := map[string]any{"type": "tool-call", "toolCallId": "one", "toolName": "lookup", "input": map[string]any{"x": 1}}
	for _, event := range []map[string]any{start, end, start, end} {
		if _, err := state.handle(event); err != nil {
			t.Fatal(err)
		}
	}
	if len(state.content) != 1 {
		t.Fatalf("repeated terminal produced %d tool calls", len(state.content))
	}
	if _, err := state.handle(map[string]any{"type": "finish", "finishReason": "tool-calls"}); err != nil {
		t.Fatal(err)
	}
}

func TestGenerateIdleTimeoutIsErrorNotAbortAndDoesNotReplay(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"text-delta\",\"text\":\"partial\"}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	router := &transportRouter{base: server.URL + "/provider/v1", client: server.Client()}
	router.selectRoute("key")
	router.remember("key", "generate")
	stream, _ := router.stream(testModel(), testRequest(), sdk.ProviderStreamOptions{Values: map[string]any{"apiKey": "key", "timeoutMs": 30, "maxRetries": 2}})
	events := collect(t, stream)
	last := events[len(events)-1]
	if last["type"] != "error" || last["reason"] != "error" {
		t.Fatalf("timeout was treated as user abort: %#v", last)
	}
	if requests.Load() != 1 {
		t.Fatal("retried a partially delivered stream")
	}
}

func TestGenerateFragmentationToolsUsageAndTruncation(t *testing.T) {
	for _, complete := range []bool{true, false} {
		t.Run(fmt.Sprint(complete), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				lines := []string{`{"type":"reasoning-delta","text":"think"}`, `{"type":"text-delta","text":"héllo"}`, `{"type":"tool-input-start","id":"c","toolName":"lookup"}`, `{"type":"tool-input-delta","id":"c","delta":"{\"x\":"}`, `{"type":"tool-input-delta","id":"c","delta":"1}"}`, `{"type":"tool-call","toolCallId":"c","toolName":"lookup","input":{"x":1}}`}
				if complete {
					lines = append(lines, `{"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":100,"outputTokens":5,"inputTokenDetails":{"cacheReadTokens":20,"cacheWriteTokens":10}}}`)
				}
				for _, line := range lines {
					for _, b := range []byte("data: " + line + "\n\n") {
						w.Write([]byte{b})
						w.(http.Flusher).Flush()
					}
				}
			}))
			defer server.Close()
			router := &transportRouter{base: server.URL + "/provider/v1", client: server.Client()}
			router.selectRoute("synthetic")
			router.remember("synthetic", "generate")
			stream, err := router.stream(testModel(), testRequest(), sdk.ProviderStreamOptions{Values: map[string]any{"apiKey": "synthetic"}})
			if err != nil {
				t.Fatal(err)
			}
			events := collect(t, stream)
			last := events[len(events)-1]
			if !complete {
				if last["type"] != "error" {
					t.Fatal("truncated stream succeeded")
				}
				return
			}
			if last["type"] != "done" || last["reason"] != "toolUse" {
				t.Fatalf("incorrect completion: %#v", last)
			}
			message := last["message"].(map[string]any)
			usage := message["usage"].(map[string]any)
			if usage["input"] != float64(70) || usage["cacheRead"] != float64(20) || usage["cacheWrite"] != float64(10) || usage["totalTokens"] != float64(105) {
				t.Fatalf("wrong usage: %#v", usage)
			}
			wantOrder := []string{"start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"}
			if len(events) != len(wantOrder) {
				t.Fatalf("unexpected stream length: %d", len(events))
			}
			for i, want := range wantOrder {
				if events[i]["type"] != want {
					t.Fatalf("event %d: got %v, want %s", i, events[i]["type"], want)
				}
			}
			starts, ends := 0, 0
			for _, event := range events {
				switch event["type"] {
				case "toolcall_start":
					starts++
				case "toolcall_end":
					ends++
				}
			}
			if starts != 1 || ends != 1 {
				t.Fatal("duplicate tool start/end")
			}
		})
	}
}
