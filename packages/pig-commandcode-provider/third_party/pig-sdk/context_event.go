package sdk

import (
	"reflect"
	"slices"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// Context transforms carry message-list identity across JSON without exposing
// transport metadata to handlers. Go handlers return a replacement slice when
// changing its length; mutations to message objects also survive a nil result.
func snapshotContextMessages(event string, data map[string]any) []any {
	if event != "context" && event != "context_with_system" {
		return nil
	}
	messages, ok := data["messages"].([]any)
	if !ok {
		return nil
	}
	return append([]any{}, messages...)
}

func contextEventResult(data map[string]any, snapshot []any, result any) any {
	messages, _ := data["messages"].([]any)
	if returned, ok := result.(map[string]any); ok {
		// A nil list encodes as null, which leaves the in-place list in effect
		// (upstream `handlerResult?.messages ?? ...`).
		switch replacement := returned["messages"].(type) {
		case nil:
		case []any:
			if replacement != nil {
				messages = replacement
			}
		case []map[string]any:
			// Incoming message objects decode as map[string]any, so this list
			// can hold them and keeps their identity.
			if replacement != nil {
				messages = make([]any, len(replacement))
				for i, message := range replacement {
					messages[i] = message
				}
			}
		default:
			if typed, ok := typedContextEventResult(result); ok {
				return typed
			}
		}
	} else if result != nil {
		if typed, ok := typedContextEventResult(result); ok {
			return typed
		}
	}
	unchanged := slices.EqualFunc(messages, snapshot, func(a, b any) bool {
		av, bv := reflect.ValueOf(a), reflect.ValueOf(b)
		if !av.IsValid() || !bv.IsValid() {
			return av.IsValid() == bv.IsValid()
		}
		if av.Type() != bv.Type() {
			return false
		}
		if av.Kind() == reflect.Map {
			return av.Pointer() == bv.Pointer()
		}
		return reflect.DeepEqual(a, b)
	})
	return map[string]any{"messages": messages, "_pigContextUnchanged": unchanged}
}

// typedContextEventResult reports a result whose messages value is not a list
// of the incoming message objects; its value semantics do not retain their
// identity. A value that encodes as a message list replaces the context, and a
// value that is not a list goes to the host unchanged, which reports it as a
// handler error. A null messages value is not handled here: like upstream's
// `handlerResult?.messages ?? ...`, the in-place list decides.
func typedContextEventResult(result any) (any, bool) {
	raw, err := json.Marshal(result)
	if err != nil {
		return result, true
	}
	var returned struct {
		Messages []any `json:"messages"`
	}
	if json.Unmarshal(raw, &returned) != nil {
		return result, true
	}
	if returned.Messages != nil {
		return map[string]any{"messages": returned.Messages, "_pigContextUnchanged": false}, true
	}
	return nil, false
}
