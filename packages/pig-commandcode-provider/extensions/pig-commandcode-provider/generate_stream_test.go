package commandcode

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func generateTestStream(t *testing.T, handler http.HandlerFunc, values map[string]any) *sdk.ModelEventStream {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	router := &transportRouter{base: server.URL + "/provider/v1", client: server.Client(), key: "synthetic", route: "generate"}
	options := map[string]any{"apiKey": "synthetic", "maxRetries": 0}
	for key, value := range values {
		options[key] = value
	}
	stream, err := router.stream(testModel(), testRequest(), sdk.ProviderStreamOptions{Values: options})
	if err != nil {
		t.Fatal(err)
	}
	return stream
}

func TestGenerateRejectsInvalidFinalToolCalls(t *testing.T) {
	for _, test := range []struct {
		name, prefix, call string
	}{
		{"malformed JSON", "", `{"type":"tool-call","toolCallId":"one","toolName":"lookup","input":"{\"x\":"}`},
		{"array", "", `{"type":"tool-call","toolCallId":"one","toolName":"lookup","input":[1]}`},
		{"null", "", `{"type":"tool-call","toolCallId":"one","toolName":"lookup","input":null}`},
		{"scalar", "", `{"type":"tool-call","toolCallId":"one","toolName":"lookup","args":true}`},
		{"encoded null", "", `{"type":"tool-call","toolCallId":"one","toolName":"lookup","arguments":"null"}`},
		{"missing arguments", "", `{"type":"tool-call","toolCallId":"one","toolName":"lookup"}`},
		{"missing name", "", `{"type":"tool-call","toolCallId":"one","input":{}}`},
		{"blank ID", "", `{"type":"tool-call","toolCallId":" ","toolName":"lookup","input":{}}`},
		{"partial arguments", "data: {\"type\":\"tool-input-start\",\"id\":\"one\",\"toolName\":\"lookup\"}\n\ndata: {\"type\":\"tool-input-delta\",\"id\":\"one\",\"delta\":\"{\\\"x\\\":\"}\n\n", `{"type":"tool-call","toolCallId":"one"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			stream := generateTestStream(t, func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "%sdata: %s\n\ndata: {\"type\":\"finish\",\"finishReason\":\"tool-calls\"}\n\n", test.prefix, test.call)
			}, map[string]any{"maxRetries": 2})
			events := collect(t, stream)
			last := events[len(events)-1]
			if last["type"] != "error" || last["reason"] != "error" {
				t.Fatalf("invalid tool call succeeded: %#v", last)
			}
			for _, event := range events {
				if event["type"] == "toolcall_end" {
					t.Fatal("invalid arguments published as a completed tool call")
				}
			}
			if requests.Load() != 1 {
				t.Fatal("invalid tool call was replayed")
			}
		})
	}
}

func TestGenerateFinalToolArguments(t *testing.T) {
	for _, test := range []struct {
		name, prefix, call string
	}{
		{"object", "", `{"type":"tool-call","toolCallId":"one","toolName":"lookup","input":{"x":1}}`},
		{"JSON string", "", `{"type":"tool-call","toolCallId":"one","toolName":"lookup","args":"{\"x\":1}"}`},
		{"arguments alias", "", `{"type":"tool-call","toolCallId":"one","toolName":"lookup","arguments":{"x":1}}`},
		{"streamed", "data: {\"type\":\"tool-input-start\",\"id\":\"one\",\"toolName\":\"lookup\"}\n\ndata: {\"type\":\"tool-input-delta\",\"id\":\"one\",\"delta\":\"{\\\"x\\\":1}\"}\n\n", `{"type":"tool-call","toolCallId":"one"}`},
		{"authoritative final", "data: {\"type\":\"tool-input-start\",\"id\":\"one\",\"toolName\":\"lookup\"}\n\ndata: {\"type\":\"tool-input-delta\",\"id\":\"one\",\"delta\":\"{\\\"x\\\":\"}\n\n", `{"type":"tool-call","toolCallId":"one","input":{"x":1}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			stream := generateTestStream(t, func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintf(w, "%sdata: %s\n\ndata: {\"type\":\"finish\",\"finishReason\":\"tool-calls\"}\n\n", test.prefix, test.call)
			}, nil)
			events := collect(t, stream)
			last := events[len(events)-1]
			if last["type"] != "done" || last["reason"] != "toolUse" {
				t.Fatalf("valid tool call failed: %#v", last)
			}
			blocks := last["message"].(map[string]any)["content"].([]any)
			call := blocks[0].(map[string]any)
			if call["name"] != "lookup" || call["arguments"].(map[string]any)["x"] != float64(1) {
				t.Fatalf("lost final arguments: %#v", call)
			}
		})
	}
}

func TestGenerateIdleTimeoutTracksBytesNotCompleteLines(t *testing.T) {
	stream := generateTestStream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"type":"text-delta","text":"`)
		w.(http.Flusher).Flush()
		// Each read makes progress within the idle budget, but the whole line
		// takes longer. Network framing must not turn this into an idle timeout.
		for range 8 {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
			fmt.Fprint(w, "x")
			w.(http.Flusher).Flush()
		}
		fmt.Fprint(w, "\"}\n\ndata: {\"type\":\"finish\",\"finishReason\":\"stop\"}\n\n")
	}, map[string]any{"timeoutMs": 250})
	events := collect(t, stream)
	last := events[len(events)-1]
	if last["type"] != "done" {
		t.Fatalf("active fragmented stream timed out: %#v", last)
	}
	blocks := last["message"].(map[string]any)["content"].([]any)
	if blocks[0].(map[string]any)["text"] != "xxxxxxxx" {
		t.Fatalf("fragmented text lost: %#v", blocks)
	}
}

func TestGenerateRetryAfterDateExceedingCapDoesNotRetry(t *testing.T) {
	var requests atomic.Int32
	stream := generateTestStream(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Retry-After", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, "busy")
	}, map[string]any{"maxRetries": 1, "maxRetryDelayMs": 1000})
	events := collect(t, stream)
	last := events[len(events)-1]
	if last["type"] != "error" || !strings.Contains(fmt.Sprint(last), "maximum retry delay") {
		t.Fatalf("HTTP-date retry cap ignored: %#v", last)
	}
	if requests.Load() != 1 {
		t.Fatalf("retried before the server allowed it: %d requests", requests.Load())
	}
}

func TestGenerateBackoffIsCappedWithoutDisablingRetries(t *testing.T) {
	var requests atomic.Int32
	stream := generateTestStream(t, func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, "data: {\"type\":\"finish\",\"finishReason\":\"stop\"}\n\n")
	}, map[string]any{"maxRetries": 1, "maxRetryDelayMs": 10})
	events := collect(t, stream)
	if last := events[len(events)-1]; last["type"] != "done" || requests.Load() != 2 {
		t.Fatalf("local backoff cap disabled retry: %#v (requests=%d)", last, requests.Load())
	}
}

func TestGenerateRetryDelayPolicy(t *testing.T) {
	now := time.Date(2026, time.October, 8, 12, 0, 0, 0, time.UTC)
	capMs, uncapped := 10, 0
	for _, test := range []struct {
		name, header string
		attempt      int
		capMs        *int
		want         time.Duration
		wantError    bool
	}{
		{name: "default", want: 500 * time.Millisecond},
		{name: "exponential", attempt: 2, want: 2 * time.Second},
		{name: "bounded exponential", attempt: 100, want: time.Minute},
		{name: "local cap", capMs: &capMs, want: 10 * time.Millisecond},
		{name: "zero server delay", header: "0", want: 0},
		{name: "fractional seconds", header: " 0.25 ", want: 250 * time.Millisecond},
		{name: "cap equality", header: "0.01", capMs: &capMs, want: 10 * time.Millisecond},
		{name: "server cap", header: "1", capMs: &capMs, wantError: true},
		{name: "disabled cap", header: "120", capMs: &uncapped, want: 2 * time.Minute},
		{name: "date", header: now.Add(10 * time.Second).Format(http.TimeFormat), want: 10 * time.Second},
		{name: "past date", header: now.Add(-time.Hour).Format(http.TimeFormat), want: 0},
		{name: "oversized date", header: now.Add(time.Hour).Format(http.TimeFormat), wantError: true},
		{name: "invalid", header: "not a delay", want: 500 * time.Millisecond},
		{name: "negative", header: "-1", want: 500 * time.Millisecond},
		{name: "NaN", header: "NaN", want: 500 * time.Millisecond},
		{name: "infinite", header: "+Inf", want: 500 * time.Millisecond},
		{name: "duration overflow", header: "1e100", wantError: true},
		{name: "uncapped duration overflow", header: "1e100", capMs: &uncapped, want: time.Duration(math.MaxInt64)},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := generateRetryDelay(test.attempt, test.header, test.capMs, now)
			if (err != nil) != test.wantError || (!test.wantError && got != test.want) {
				t.Fatalf("delay=%s err=%v; want %s error=%v", got, err, test.want, test.wantError)
			}
		})
	}
}

func TestGenerateStalledPartialLineTimesOutAndDisconnects(t *testing.T) {
	disconnected := make(chan struct{})
	var requests atomic.Int32
	stream := generateTestStream(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		fmt.Fprint(w, `data: {"type":"text-delta","text":"unfinished`)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(disconnected)
	}, map[string]any{"timeoutMs": 100, "maxRetries": 2})
	events := collect(t, stream)
	last := events[len(events)-1]
	if last["type"] != "error" || last["reason"] != "error" || !strings.Contains(fmt.Sprint(last), "timed out") {
		t.Fatalf("stalled partial line did not time out: %#v", last)
	}
	select {
	case <-disconnected:
	case <-time.After(time.Second):
		t.Fatal("timed-out request remained connected")
	}
	if requests.Load() != 1 {
		t.Fatal("partially received stream was replayed")
	}
}

func TestGenerateInterleavedToolsKeepSnapshotsAndEmptyArguments(t *testing.T) {
	stream := generateTestStream(t, func(w http.ResponseWriter, r *http.Request) {
		for _, line := range []string{
			`{"type":"tool-input-start","id":"one","toolName":"lookup"}`,
			`{"type":"tool-input-start","id":"two","toolName":"lookup"}`,
			`{"type":"tool-input-delta","id":"one","delta":"{\"x\":"}`,
			`{"type":"tool-call","toolCallId":"two","input":{}}`,
			`{"type":"tool-input-delta","id":"one","delta":"1}"}`,
			`{"type":"tool-call","toolCallId":"one"}`,
			`{"type":"tool-input-start","id":"two","toolName":"lookup"}`,
			`{"type":"tool-call","toolCallId":"two","input":{"ignored":true}}`,
			`{"type":"finish","finishReason":"tool-calls"}`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", line)
		}
	}, nil)
	events := collect(t, stream)
	last := events[len(events)-1]
	if last["type"] != "done" || last["reason"] != "toolUse" {
		t.Fatalf("interleaved tools failed: %#v", last)
	}
	starts, ends := 0, 0
	for _, event := range events {
		switch event["type"] {
		case "toolcall_start":
			starts++
			blocks := event["partial"].(map[string]any)["content"].([]any)
			index := int(event["contentIndex"].(float64))
			if len(blocks[index].(map[string]any)["arguments"].(map[string]any)) != 0 {
				t.Fatal("later arguments mutated the start snapshot")
			}
		case "toolcall_end":
			ends++
			call := event["toolCall"].(map[string]any)
			args := call["arguments"].(map[string]any)
			if (call["id"] == "one" && args["x"] != float64(1)) || (call["id"] == "two" && len(args) != 0) {
				t.Fatalf("interleaved arguments mixed: %#v", call)
			}
		}
	}
	if starts != 2 || ends != 2 {
		t.Fatalf("duplicate/missing tool events: starts=%d ends=%d", starts, ends)
	}
}

func TestGenerateCancelDuringRetryWait(t *testing.T) {
	var requests atomic.Int32
	requested := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			close(requested)
		}
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	router := &transportRouter{base: server.URL + "/provider/v1", client: server.Client(), key: "synthetic", route: "generate"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := router.stream(testModel(), testRequest(), sdk.ProviderStreamOptions{Signal: ctx, Values: map[string]any{"apiKey": "synthetic", "maxRetries": 2}})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-requested:
	case <-time.After(5 * time.Second):
		t.Fatal("no request")
	}
	cancel()
	events := collect(t, stream)
	if last := events[len(events)-1]; last["type"] != "error" || last["reason"] != "aborted" || requests.Load() != 1 {
		t.Fatalf("retry wait did not abort: %#v (requests=%d)", last, requests.Load())
	}
}
