package commandcode

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func TestResponseAndRawObserversPrecedeNormalizationAndRejectStream(t *testing.T) {
	for _, route := range []string{"provider", "generate"} {
		for _, reject := range []string{"", "response", "raw"} {
			t.Run(route+"/reject="+reject, func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					w.Header().Set("X-Observer", "synthetic")
					if route == "generate" {
						fmt.Fprint(w, "data: {\"type\":\"text-delta\",\"text\":\"observed\"}\n\ndata: {\"type\":\"finish\",\"finishReason\":\"stop\"}\n\n")
					} else {
						fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"observed\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
					}
				}))
				defer server.Close()
				model := testModel()
				model["baseUrl"] = server.URL + "/provider/v1"
				router := &transportRouter{base: server.URL + "/provider/v1", client: server.Client(), key: "synthetic", route: route}
				order := []string{}
				options := sdk.ProviderStreamOptions{Values: map[string]any{"apiKey": "synthetic", "maxRetries": 0},
					OnResponse: func(response, received map[string]any) error {
						order = append(order, "response")
						if response["status"] != 200 || !reflect.DeepEqual(received, model) {
							t.Errorf("response: %+v model: %+v", response, received)
						}
						if reject == "response" {
							return errors.New("observer rejected response")
						}
						return nil
					},
					OnProviderStreamEvent: func(data any, received map[string]any) error {
						order = append(order, "raw")
						payload, ok := data.(map[string]any)
						if !ok { // The public adapter can expose its typed parsed event.
							var err error
							payload, err = eventMap(data)
							if err != nil {
								t.Fatal(err)
							}
						}
						if route == "provider" && payload["choices"] == nil {
							t.Errorf("not raw OpenAI data: %+v", payload)
						}
						if route == "generate" && payload["type"] == nil {
							t.Errorf("not raw Generate data: %+v", payload)
						}
						if !reflect.DeepEqual(received, model) {
							t.Error("wrong model")
						}
						if reject == "raw" {
							return errors.New("observer rejected raw")
						}
						return nil
					},
				}
				stream, err := router.stream(model, testRequest(), options)
				if err != nil {
					t.Fatal(err)
				}
				events := collect(t, stream)
				if len(order) == 0 || order[0] != "response" {
					t.Fatalf("observer order: %v", order)
				}
				terminal := events[len(events)-1]
				if reject == "" {
					if len(order) < 2 || terminal["type"] != "done" {
						t.Fatalf("order=%v terminal=%+v", order, terminal)
					}
				} else {
					if terminal["type"] != "error" || !strings.Contains(fmt.Sprint(terminal), "observer rejected "+reject) {
						t.Fatalf("terminal: %+v", terminal)
					}
					if reject == "response" && len(order) != 1 {
						t.Fatalf("raw observed after rejection: %v", order)
					}
					for _, event := range events {
						if event["type"] == "text_delta" {
							t.Fatal("rejected raw event was normalized")
						}
					}
				}
			})
		}
	}
}
