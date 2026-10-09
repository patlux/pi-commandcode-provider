package commandcode

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/MichaelKinsy/PiG/ai"
)

// The host persists our custom API identity, but direct transports use it to
// decide whether signed reasoning belongs to this model. Rebind only our own
// messages; foreign-provider history must retain its original identity.
func providerTranscript(transcript ai.TranscriptContext, model *ai.Model) ai.TranscriptContext {
	messages := transcript.Messages()
	for index, message := range messages {
		if assistant, ok := message.(ai.AssistantMessage); ok && assistant.Provider == providerID && assistant.API == customAPI {
			if strings.HasPrefix(assistant.Model, "claude-") {
				assistant.API = ai.APIAnthropicMessages
			} else {
				assistant.API = ai.APIOpenAICompletions
			}
			messages[index] = assistant
		}
	}
	return ai.NormalizeContext(ai.Context{Messages: messages})
}

// The SDK deliberately uses JSON maps. Decode each closed message union explicitly
// rather than dropping unfamiliar roles or replacing system instructions.
func decodeTranscript(request map[string]any) (ai.TranscriptContext, error) {
	data, err := json.Marshal(request)
	if err != nil {
		return ai.TranscriptContext{}, err
	}
	var wire struct {
		Messages     []json.RawMessage `json:"messages"`
		SystemPrompt string            `json:"systemPrompt"`
		Tools        []ai.ToolSchema   `json:"tools"`
	}
	if err = json.Unmarshal(data, &wire); err != nil {
		return ai.TranscriptContext{}, err
	}
	messages := make([]ai.Message, 0, len(wire.Messages))
	for index, raw := range wire.Messages {
		var header struct {
			Role         string             `json:"role"`
			Content      json.RawMessage    `json:"content"`
			Timestamp    int64              `json:"timestamp"`
			Sections     ai.OrderedSections `json:"sections"`
			ToolsAdded   []ai.ToolSchema    `json:"toolsAdded"`
			ToolsRemoved []ai.ToolReference `json:"toolsRemoved"`
		}
		if err = json.Unmarshal(raw, &header); err != nil {
			return ai.TranscriptContext{}, fmt.Errorf("message %d: %w", index, err)
		}
		switch header.Role {
		case "system":
			var content ai.SystemContent = ai.SystemText("")
			if len(header.Content) > 0 && string(header.Content) != "null" {
				var text string
				if json.Unmarshal(header.Content, &text) == nil {
					content = ai.SystemText(text)
				} else {
					var blocks []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					}
					if err = json.Unmarshal(header.Content, &blocks); err != nil {
						return ai.TranscriptContext{}, err
					}
					texts := ai.SystemTextBlocks{}
					for _, block := range blocks {
						if block.Type != "text" {
							return ai.TranscriptContext{}, fmt.Errorf("unsupported system content %q", block.Type)
						}
						texts = append(texts, ai.TextContent{Text: block.Text})
					}
					content = texts
				}
			}
			messages = append(messages, ai.SystemMessage{Content: content, Timestamp: header.Timestamp, Sections: header.Sections, ToolsAdded: header.ToolsAdded, ToolsRemoved: header.ToolsRemoved})
		case "user":
			var content ai.UserContent
			var text string
			if json.Unmarshal(header.Content, &text) == nil {
				content = ai.UserText(text)
			} else {
				var rawBlocks []json.RawMessage
				if err = json.Unmarshal(header.Content, &rawBlocks); err != nil {
					return ai.TranscriptContext{}, err
				}
				blocks := ai.UserContentBlocks{}
				for _, rawBlock := range rawBlocks {
					block, e := ai.UnmarshalContentBlock(rawBlock)
					if e != nil {
						return ai.TranscriptContext{}, e
					}
					typed, ok := block.(ai.UserContentBlock)
					if !ok {
						return ai.TranscriptContext{}, fmt.Errorf("unsupported user content %T", block)
					}
					blocks = append(blocks, typed)
				}
				content = blocks
			}
			messages = append(messages, ai.UserMessage{Content: content, Timestamp: header.Timestamp})
		case "assistant":
			var message ai.AssistantMessage
			if err = json.Unmarshal(raw, &message); err != nil {
				return ai.TranscriptContext{}, err
			}
			messages = append(messages, message)
		case "toolResult":
			var message ai.ToolResultMessage
			if err = json.Unmarshal(raw, &message); err != nil {
				return ai.TranscriptContext{}, err
			}
			messages = append(messages, message)
		default:
			return ai.TranscriptContext{}, fmt.Errorf("unsupported transcript role %q", header.Role)
		}
	}
	return ai.NormalizeContext(ai.Context{Messages: messages, SystemPrompt: wire.SystemPrompt, Tools: wire.Tools}), nil
}
