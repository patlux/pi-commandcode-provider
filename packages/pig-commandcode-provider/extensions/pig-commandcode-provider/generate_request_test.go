package commandcode

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/MichaelKinsy/PiG/ai"
)

func TestGenerateHistoryOmitsFailedAssistantTurnsAndTheirResults(t *testing.T) {
	for _, reason := range []ai.StopReason{ai.StopReasonError, ai.StopReasonAborted} {
		t.Run(string(reason), func(t *testing.T) {
			messages := []ai.Message{
				ai.UserMessage{Content: ai.UserText("before")},
				ai.AssistantMessage{StopReason: reason, Content: []ai.AssistantContentBlock{
					ai.TextContent{Text: "failed-answer-must-not-replay"},
					ai.ToolCall{ID: "failed-call", Name: "lookup", Arguments: map[string]any{"partial": true}},
				}},
				ai.ToolResultMessage{ToolCallID: "failed-call", ToolName: "lookup", Content: []ai.ToolResultMessageContent{ai.TextContent{Text: "failed-result-must-not-replay"}}},
				ai.UserMessage{Content: ai.UserText("recover")},
				ai.AssistantMessage{StopReason: ai.StopReasonToolUse, Content: []ai.AssistantContentBlock{ai.ToolCall{ID: "retained-call", Name: "lookup", Arguments: map[string]any{"valid": true}}}},
			}
			before, err := json.Marshal(messages)
			if err != nil {
				t.Fatal(err)
			}
			converted, err := generateMessages(messages, false)
			if err != nil {
				t.Fatal(err)
			}
			data, _ := json.Marshal(converted)
			if strings.Contains(string(data), "failed-") {
				t.Fatalf("failed assistant content or orphan result replayed: %s", data)
			}
			if !strings.Contains(string(data), "retained-call") || !strings.Contains(string(data), "error-text") {
				t.Fatalf("valid interrupted tool flow was not repaired: %s", data)
			}
			after, _ := json.Marshal(messages)
			if string(before) != string(after) {
				t.Fatal("conversion mutated retained history")
			}
		})
	}
}

func TestGenerateRequestLimitSlugAndSchemaPolicy(t *testing.T) {
	model, err := nativeModel((modelEntry{ID: "google/gemini-2.5-pro", Name: "Gemini", ContextWindow: 200000}).wire(defaultBase))
	if err != nil {
		t.Fatal(err)
	}
	model.Capabilities.MaxOutputTokens = 100000
	schema := map[string]any{"type": "object", "properties": map[string]any{"value": map[string]any{"type": []any{"string", "null"}, "default": nil, "enum": []any{"null", nil}}}, "required": []any{"value"}}
	original, _ := json.Marshal(schema)
	transcript := ai.NormalizeContext(ai.Context{Messages: []ai.Message{ai.UserMessage{Content: ai.UserText("hello")}}, Tools: []ai.ToolSchema{{Name: "lookup", Parameters: schema}}})
	body, err := generatePayload(model, transcript, ai.StreamOptions{MaxTokens: 90000})
	if err != nil {
		t.Fatal(err)
	}
	params := body["params"].(map[string]any)
	if params["max_tokens"] != 64000 {
		t.Errorf("generate limit = %v", params["max_tokens"])
	}
	if got := projectSlug("/Users/Test/My Project"); got != "users-test-my-project" {
		t.Errorf("slug = %q", got)
	}
	tool := params["tools"].([]any)[0].(map[string]any)
	converted := tool["input_schema"].(map[string]any)["properties"].(map[string]any)["value"].(map[string]any)
	if converted["type"] != "string" || converted["nullable"] != true {
		t.Errorf("unsafe Gemini schema: %#v", converted)
	}
	if _, present := converted["default"]; present {
		t.Error("null default remains")
	}
	if !reflect.DeepEqual(converted["enum"], []any{"null", nil}) {
		t.Error("literal enum was changed")
	}
	after, _ := json.Marshal(schema)
	if string(after) != string(original) {
		t.Fatal("mutated source schema")
	}
}
