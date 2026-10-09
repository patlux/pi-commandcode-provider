package livedriver

import (
	"encoding/json"
	"errors"
	"strings"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

// Test-only bounded request driver. Not shipped in either provider package.
func Extension() *sdk.Extension {
	ext := sdk.New("pig-live-driver")
	ext.Command("test-live", "One bounded request with no tools or retries", func(ctx sdk.Context, args string) error {
		model := ctx.ModelRegistry().Find("commandcode", strings.TrimSpace(args))
		if model == nil {
			return errors.New("requested live model is unavailable")
		}
		stream := ctx.ModelRegistry().StreamSimple(model, map[string]any{"messages": []any{map[string]any{"role": "user", "content": "Reply exactly: native-live-ok"}}}, map[string]any{"maxTokens": 64, "reasoning": "off", "maxRetries": 0, "timeoutMs": 30000})
		message := stream.Result()
		// Never print provider error bodies, credentials or returned content.
		if message["stopReason"] != "stop" {
			return errors.New("bounded request failed or exceeded output limit")
		}
		encoded, _ := json.Marshal(message["content"])
		if !strings.Contains(string(encoded), "native-live-ok") {
			return errors.New("bounded request did not return marker")
		}
		ctx.Notify("bounded-live-ok", "info")
		return nil
	})
	return ext
}
