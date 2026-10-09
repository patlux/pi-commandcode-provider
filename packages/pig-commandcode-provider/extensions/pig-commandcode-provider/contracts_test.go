package commandcode

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/MichaelKinsy/PiG/ai"
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

type contractFixtures struct {
	Version int `json:"version"`
	History []struct {
		Name          string `json:"name"`
		Messages      []any  `json:"messages"`
		AllowImages   bool   `json:"allowImages"`
		Expected      []any  `json:"expected"`
		ErrorContains string `json:"errorContains"`
	} `json:"history"`
	Streams []struct {
		Name     string `json:"name"`
		Events   []any  `json:"events"`
		Expected struct {
			Reason        string         `json:"reason"`
			Content       []any          `json:"content"`
			EventTypes    []string       `json:"eventTypes"`
			ToolEnds      *int           `json:"toolEnds"`
			ErrorContains string         `json:"errorContains"`
			Usage         map[string]any `json:"usage"`
		} `json:"expected"`
	} `json:"streams"`
	Retries []struct {
		Name            string `json:"name"`
		Status          int    `json:"status"`
		RetryAfter      string `json:"retryAfter"`
		MaxRetries      int    `json:"maxRetries"`
		MaxRetryDelayMs int    `json:"maxRetryDelayMs"`
		Requests        int32  `json:"requests"`
		Reason          string `json:"reason"`
	} `json:"retries"`
}

func readContracts(t *testing.T) contractFixtures {
	t.Helper()
	data, err := os.ReadFile("testdata/contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	var result contractFixtures
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&result); err != nil {
		t.Fatal(err)
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		t.Fatalf("trailing fixture data: %v", err)
	}
	if result.Version != 1 || len(result.History) == 0 || len(result.Streams) == 0 || len(result.Retries) == 0 {
		t.Fatal("invalid or empty contracts")
	}
	return result
}

func contractTerminal(t *testing.T, events []map[string]any, reason string) map[string]any {
	t.Helper()
	last := events[len(events)-1]
	kind, field := "done", "message"
	if reason == "error" || reason == "aborted" {
		kind, field = "error", "error"
	}
	if last["type"] != kind || last["reason"] != reason {
		t.Fatalf("unexpected terminal: %#v", last)
	}
	message := last[field].(map[string]any)
	if message["stopReason"] != reason {
		t.Fatalf("stopReason: %#v", message)
	}
	return message
}

// A byte at a time exercises UTF-8 and JSON boundaries, without sockets or a
// scheduler-sensitive transport. The real HTTP lifecycle is covered by E2E.
type contractReader struct{ io.Reader }

func (r contractReader) Read(buffer []byte) (int, error) {
	if len(buffer) > 1 {
		buffer = buffer[:1]
	}
	return r.Reader.Read(buffer)
}
func contractBody(events []any) io.ReadCloser {
	var body strings.Builder
	body.WriteString(": heartbeat\nevent: message\nnot-json\n")
	for _, event := range events {
		data, err := json.Marshal(event)
		if err != nil {
			panic(err)
		}
		body.WriteString("data: " + string(data) + "\n\n")
	}
	return io.NopCloser(contractReader{strings.NewReader(body.String())})
}

func contractStream(t *testing.T, fetch ai.FetchFunction, options map[string]any) []map[string]any {
	t.Helper()
	router := &transportRouter{base: "https://contract.invalid/provider/v1", client: &http.Client{Transport: fetch}, key: "synthetic-contract-key", route: "generate"}
	options["apiKey"] = "synthetic-contract-key"
	stream, err := router.stream(testModel(), testRequest(), sdk.ProviderStreamOptions{Values: options})
	if err != nil {
		t.Fatal(err)
	}
	return collect(t, stream)
}

func TestSharedContracts(t *testing.T) {
	fixtures := readContracts(t)
	t.Run("history", func(t *testing.T) {
		for _, test := range fixtures.History {
			t.Run(test.Name, func(t *testing.T) {
				transcript, err := decodeTranscript(map[string]any{"messages": test.Messages})
				if err != nil {
					t.Fatal(err)
				}
				messages := transcript.Messages()
				before, _ := json.Marshal(messages)
				got, err := generateMessages(messages, test.AllowImages)
				if test.ErrorContains != "" {
					if err == nil || !strings.Contains(err.Error(), test.ErrorContains) {
						t.Fatalf("expected %q, got %v", test.ErrorContains, err)
					}
				} else if err != nil {
					t.Fatal(err)
				} else {
					// Compare wire JSON, not Go's named map types (ai.JsonObject).
					actual, err := json.Marshal(got)
					if err != nil {
						t.Fatal(err)
					}
					expected, err := json.Marshal(test.Expected)
					if err != nil {
						t.Fatal(err)
					}
					if !bytes.Equal(actual, expected) {
						t.Fatalf("got %s; want %s", actual, expected)
					}
				}
				after, _ := json.Marshal(messages)
				if !bytes.Equal(before, after) {
					t.Fatal("conversion mutated retained history")
				}
			})
		}
	})
	t.Run("streams", func(t *testing.T) {
		for _, test := range fixtures.Streams {
			t.Run(test.Name, func(t *testing.T) {
				var requests atomic.Int32
				events := contractStream(t, ai.FetchFunction(func(req *http.Request) (*http.Response, error) {
					requests.Add(1)
					return &http.Response{StatusCode: 200, Header: http.Header{}, Body: contractBody(test.Events), Request: req}, nil
				}), map[string]any{"maxRetries": 2, "maxRetryDelayMs": 1})
				message := contractTerminal(t, events, test.Expected.Reason)
				if requests.Load() != 1 {
					t.Fatal("stream was replayed")
				}
				if test.Expected.Content != nil && !reflect.DeepEqual(message["content"], test.Expected.Content) {
					t.Fatalf("content: %#v", message["content"])
				}
				types, ends := []string{}, 0
				for _, event := range events {
					types = append(types, stringField(event, "type"))
					if event["type"] == "toolcall_end" {
						ends++
					}
				}
				if test.Expected.EventTypes != nil && !reflect.DeepEqual(types, test.Expected.EventTypes) {
					t.Fatalf("events: %v", types)
				}
				if test.Expected.ToolEnds != nil && ends != *test.Expected.ToolEnds {
					t.Fatalf("tool ends: %d", ends)
				}
				if test.Expected.ErrorContains != "" && !strings.Contains(stringField(message, "errorMessage"), test.Expected.ErrorContains) {
					t.Fatalf("error: %#v", message)
				}
				if test.Expected.Usage != nil {
					usage := cloneJSON(message["usage"]).(map[string]any)
					delete(usage, "cost")
					if !reflect.DeepEqual(usage, test.Expected.Usage) {
						t.Fatalf("usage: %#v", usage)
					}
				}
			})
		}
	})
	t.Run("retries", func(t *testing.T) {
		for _, test := range fixtures.Retries {
			t.Run(test.Name, func(t *testing.T) {
				var requests atomic.Int32
				events := contractStream(t, ai.FetchFunction(func(req *http.Request) (*http.Response, error) {
					res := &http.Response{StatusCode: 200, Header: http.Header{}, Body: contractBody([]any{map[string]any{"type": "finish", "finishReason": "stop"}}), Request: req}
					if requests.Add(1) == 1 {
						res.StatusCode = test.Status
						res.Header.Set("Retry-After", test.RetryAfter)
						res.Body = io.NopCloser(strings.NewReader("synthetic failure"))
					}
					return res, nil
				}), map[string]any{"maxRetries": test.MaxRetries, "maxRetryDelayMs": test.MaxRetryDelayMs})
				contractTerminal(t, events, test.Reason)
				if requests.Load() != test.Requests {
					t.Fatalf("requests: %d, want %d", requests.Load(), test.Requests)
				}
			})
		}
	})
}
