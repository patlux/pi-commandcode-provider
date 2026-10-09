package sdk

// Event payloads arrive as decoded JSON rather than typed structs, because the
// set of events is open and an extension subscribes by name. The message-shaped
// events all carry the same envelope:
//
//	{"type": "message_end", "message": {"role": "assistant", "content": [...]}}
//
// where content is a block array, never a bare string. Reading it by hand is
// where extensions go wrong: content.(string) always fails, and guessing at
// Go-side field names like "Assistant" finds nothing, because the wire is
// upstream's flat role-discriminated union.

// MessageRole reports the role of an event's message payload, or "" when the
// event carries no message.
func MessageRole(data map[string]any) string {
	msg, ok := data["message"].(map[string]any)
	if !ok {
		return ""
	}
	role, _ := msg["role"].(string)
	return role
}

// MessageText concatenates the text blocks of an event's message payload.
// Non-text blocks (tool calls, images, thinking) are skipped. Returns "" when
// the event carries no message or the message has no text.
func MessageText(data map[string]any) string {
	msg, ok := data["message"].(map[string]any)
	if !ok {
		return ""
	}
	return textFromContent(msg["content"])
}

// textFromContent accepts the block array the wire always sends. A bare string
// is also accepted so a caller handling a hand-built payload is not surprised.
func textFromContent(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var out []byte
		for _, raw := range v {
			block, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if kind, _ := block["type"].(string); kind != "text" {
				continue
			}
			if text, ok := block["text"].(string); ok {
				out = append(out, text...)
			}
		}
		return string(out)
	default:
		return ""
	}
}
