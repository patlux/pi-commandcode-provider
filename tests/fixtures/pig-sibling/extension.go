package sibling

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// Synthetic test driver. It is never included in either npm package.
func Extension() *sdk.Extension {
	ext := sdk.New("pig-sibling")
	var mu sync.Mutex
	hooks := map[string]int{}
	rawKinds := map[string]int{}
	responses := map[string]int{}
	calls := 0
	ext.Tool("count_test", "Increment a synthetic in-memory counter", sdk.Schema{"type": "object", "properties": map[string]any{"value": map[string]any{"type": "string"}}, "required": []string{"value"}}, func(_ sdk.Context, params map[string]any) (any, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		return map[string]any{"content": []any{map[string]any{"type": "text", "text": "counted:" + params["value"].(string)}}}, nil
	})
	ext.Command("test-count", "Read synthetic tool effects", func(ctx sdk.Context, _ string) error {
		mu.Lock()
		defer mu.Unlock()
		data, _ := json.Marshal(map[string]any{"toolCalls": calls})
		ctx.Notify(string(data), "info")
		return nil
	})
	ext.Command("test-reload", "Reload the isolated test session", func(ctx sdk.Context, _ string) error { return ctx.Reload() })
	for _, name := range []string{"before_provider_request", "after_provider_response", "provider_stream_event"} {
		ext.OnEvent(name, func(_ sdk.Context, event map[string]any) (any, error) {
			mu.Lock()
			defer mu.Unlock()
			hooks[name]++
			if name == "provider_stream_event" {
				if data, ok := event["data"].(map[string]any); ok {
					kind, _ := data["type"].(string)
					if _, ok := data["choices"]; ok {
						kind = "openai-choices"
					}
					rawKinds[kind]++
				}
			}
			if name == "after_provider_response" {
				if status, ok := event["status"].(float64); ok && status == 200 {
					responses["ok"]++
				}
			}
			return nil, nil
		})
	}
	ext.Command("test-hooks", "Report hook counts", func(ctx sdk.Context, _ string) error {
		mu.Lock()
		defer mu.Unlock()
		data, _ := json.Marshal(map[string]any{"counts": hooks, "rawKinds": rawKinds, "responses": responses})
		ctx.Notify(string(data), "info")
		return nil
	})
	ext.Command("test-key-change", "Change a synthetic request credential without reloading", func(ctx sdk.Context, _ string) error {
		model := ctx.ModelRegistry().Find("commandcode", "gpt-5.4")
		if model == nil {
			return errors.New("missing Command Code model")
		}
		stream := ctx.ModelRegistry().StreamSimple(model, map[string]any{"messages": []any{map[string]any{"role": "user", "content": "rotated key request"}}}, map[string]any{"apiKey": "synthetic-rotated-key", "maxRetries": 0, "maxTokens": 100, "temperature": 0, "headers": map[string]any{"x-test-option": "forwarded"}})
		if stream.Result()["stopReason"] != "stop" {
			return errors.New("rotated credential request failed")
		}
		ctx.Notify("key-change-ok", "info")
		return nil
	})
	ext.Command("test-sibling", "Stream through the host model registry", func(ctx sdk.Context, _ string) error {
		model := ctx.ModelRegistry().Find("commandcode", "gpt-5.4")
		if model == nil {
			return errors.New("missing Command Code model")
		}
		stream := ctx.ModelRegistry().StreamSimple(model, map[string]any{"messages": []any{map[string]any{"role": "user", "content": "sibling request"}}}, nil)
		message := stream.Result()
		if message["stopReason"] != "stop" {
			return errors.New("sibling completion failed")
		}
		ctx.Notify("sibling-ok", "info")
		return nil
	})
	ext.Command("test-failed-history", "Replay history through the registry without an agent turn", func(ctx sdk.Context, _ string) error {
		model := ctx.ModelRegistry().Find("commandcode", "gpt-5.4")
		if model == nil {
			return errors.New("missing Command Code model")
		}
		for _, reason := range []string{"error", "aborted"} {
			request := map[string]any{"messages": []any{
				map[string]any{"role": "user", "content": "synthetic-replay-check"},
				map[string]any{"role": "assistant", "api": "commandcode-custom", "provider": "commandcode", "model": "gpt-5.4", "stopReason": reason, "content": []any{
					map[string]any{"type": "text", "text": "failed-answer-must-not-replay"},
					map[string]any{"type": "toolCall", "id": "failed-call", "name": "count_test", "arguments": map[string]any{"value": "partial"}},
				}},
				map[string]any{"role": "toolResult", "toolCallId": "failed-call", "toolName": "count_test", "content": []any{map[string]any{"type": "text", "text": "failed-result-must-not-replay"}}},
				map[string]any{"role": "user", "content": "recover"},
			}}
			stream := ctx.ModelRegistry().StreamSimple(model, request, map[string]any{"maxRetries": 0})
			if stream.Result()["stopReason"] != "stop" {
				return errors.New("failed-history replay did not recover")
			}
		}
		ctx.Notify("failed-history-ok", "info")
		return nil
	})
	ext.Command("test-login", "Run real native OAuth login callback through host", func(ctx sdk.Context, _ string) error {
		provider, err := ctx.ModelRegistry().GetProvider("commandcode")
		if err != nil {
			return err
		}
		credential, err := provider.Auth.OAuth.Login(sdk.AuthInteraction{Signal: context.Background(), Prompt: func(prompt map[string]any) (string, error) {
			message, _ := prompt["message"].(string)
			answer, ok, err := ctx.Input(message, "")
			if err != nil {
				return "", err
			}
			if !ok {
				return "", errors.New("test login canceled")
			}
			return answer, nil
		}, Notify: func(event map[string]any) error {
			message, _ := event["url"].(string)
			ctx.Notify(message, "info")
			return nil
		}})
		if err != nil {
			return err
		}
		auth, err := provider.Auth.OAuth.ToAuth(credential)
		if err != nil {
			return err
		}
		if auth["apiKey"] != "synthetic-pig-key" {
			return errors.New("unexpected login credential")
		}
		ctx.Notify("login-validated-ok", "info")
		return nil
	})
	return ext
}
