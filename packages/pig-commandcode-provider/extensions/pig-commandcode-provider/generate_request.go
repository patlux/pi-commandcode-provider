package commandcode

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/MichaelKinsy/PiG/ai"
	"github.com/google/uuid"
)

func imagePart(image ai.ImageContent, allowed bool) (map[string]any, error) {
	if !allowed {
		return nil, errors.New("selected Command Code model does not support image input")
	}
	if image.Data == "" || !strings.HasPrefix(image.MimeType, "image/") {
		return nil, errors.New("invalid image content")
	}
	if _, err := base64.StdEncoding.DecodeString(image.Data); err != nil {
		return nil, errors.New("invalid image base64")
	}
	return map[string]any{"type": "image", "image": "data:" + image.MimeType + ";base64," + image.Data, "mimeType": image.MimeType}, nil
}

func generateMessages(messages []ai.Message, allowImages bool) ([]any, error) {
	// Registry callers can bypass the agent's history repair. Match standard
	// transports: failed/aborted assistant turns are not valid replay history.
	// Clone before filtering so the caller's retained transcript stays intact.
	messages = slices.DeleteFunc(slices.Clone(messages), func(message ai.Message) bool {
		assistant, ok := message.(ai.AssistantMessage)
		return ok && (assistant.StopReason == ai.StopReasonError || assistant.StopReason == ai.StopReasonAborted)
	})
	calls, results := map[string]bool{}, map[string]bool{}
	for _, message := range messages {
		switch message := message.(type) {
		case ai.AssistantMessage:
			for _, block := range message.Content {
				if call, ok := block.(ai.ToolCall); ok {
					calls[call.ID] = true
				}
			}
		case ai.ToolResultMessage:
			results[message.ToolCallID] = true
		}
	}
	out := []any{}
	pendingImages := []any{}
	flushImages := func() {
		if len(pendingImages) > 0 {
			out = append(out, map[string]any{"role": "user", "content": pendingImages})
			pendingImages = []any{}
		}
	}
	for _, message := range messages {
		if _, tool := message.(ai.ToolResultMessage); !tool {
			flushImages()
		}
		switch message := message.(type) {
		case ai.SystemMessage: // Current system/tool state is carried in params.
		case ai.UserMessage:
			var content any
			switch value := message.Content.(type) {
			case ai.UserText:
				content = string(value)
			case ai.UserContentBlocks:
				parts := []any{}
				for _, block := range value {
					switch block := block.(type) {
					case ai.TextContent:
						parts = append(parts, map[string]any{"type": "text", "text": block.Text})
					case ai.ImageContent:
						part, err := imagePart(block, allowImages)
						if err != nil {
							return nil, err
						}
						parts = append(parts, part)
					}
				}
				content = parts
			default:
				return nil, errors.New("unsupported user content")
			}
			out = append(out, map[string]any{"role": "user", "content": content})
		case ai.AssistantMessage:
			parts, missing := []any{}, []any{}
			for _, block := range message.Content {
				switch block := block.(type) {
				case ai.TextContent:
					parts = append(parts, map[string]any{"type": "text", "text": block.Text})
				case ai.ToolCall:
					if block.ID == "" {
						continue
					}
					parts = append(parts, map[string]any{"type": "tool-call", "toolCallId": block.ID, "toolName": block.Name, "input": block.Arguments})
					if !results[block.ID] {
						missing = append(missing, map[string]any{"type": "tool-result", "toolCallId": block.ID, "toolName": block.Name, "output": map[string]any{"type": "error-text", "value": "No result — the tool call did not complete (interrupted or lost)."}})
					}
				case ai.ThinkingContent: // The generate API does not accept reasoning history.
				}
			}
			if len(parts) > 0 {
				out = append(out, map[string]any{"role": "assistant", "content": parts})
			}
			if len(missing) > 0 {
				out = append(out, map[string]any{"role": "tool", "content": missing})
			}
		case ai.ToolResultMessage:
			if !calls[message.ToolCallID] {
				continue
			}
			texts := []string{}
			omittedImage := false
			for _, block := range message.Content {
				switch block := block.(type) {
				case ai.TextContent:
					texts = append(texts, block.Text)
				case ai.ImageContent:
					if !allowImages {
						omittedImage = true
						continue
					}
					part, err := imagePart(block, allowImages)
					if err != nil {
						return nil, err
					}
					pendingImages = append(pendingImages, part)
				}
			}
			kind := "text"
			if message.IsError {
				kind = "error-text"
			}
			text := strings.Join(texts, "\n")
			if text == "" && omittedImage {
				text = "[Image omitted: model does not support images]"
			}
			out = append(out, map[string]any{"role": "tool", "content": []any{map[string]any{"type": "tool-result", "toolCallId": message.ToolCallID, "toolName": message.ToolName, "output": map[string]any{"type": kind, "value": text}}}})
		default:
			return nil, fmt.Errorf("unsupported message %T", message)
		}
	}
	flushImages()
	return out, nil
}

var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)
var drivePattern = regexp.MustCompile(`^[a-z]:`)

func projectSlug(cwd string) string {
	slug := slugPattern.ReplaceAllString(drivePattern.ReplaceAllString(strings.ToLower(cwd), ""), "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		return "project"
	}
	return slug
}

func generatePayload(model *ai.Model, transcript ai.TranscriptContext, options ai.StreamOptions) (map[string]any, error) {
	messages, err := generateMessages(transcript.Messages(), slices.Contains(model.Input, "image"))
	if err != nil {
		return nil, err
	}
	tools := []any{}
	for _, tool := range ai.GetCurrentTools(transcript.Messages()) {
		var schema any = tool.Parameters
		if strings.HasPrefix(model.ID, "google/gemini-") {
			schema = geminiSafeSchema(schema)
		}
		tools = append(tools, map[string]any{"type": "function", "name": tool.Name, "description": tool.Description, "input_schema": schema})
	}
	limit := 64000
	if options.MaxTokens > 0 {
		limit = options.MaxTokens
	}
	limit = min(limit, model.Capabilities.MaxOutputTokens, 64000)
	params := map[string]any{"model": model.ID, "messages": messages, "tools": tools, "system": ai.GetCurrentSystemPrompt(transcript.Messages()), "max_tokens": limit, "stream": true}
	if options.TemperatureSet {
		params["temperature"] = options.Temperature
	}
	if effort, ok := model.ThinkingLevelMap[options.Thinking]; ok && model.ProviderMeta.Reasoning && options.Thinking != "off" && effort != nil && *effort != "off" {
		params["reasoning_effort"] = *effort
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	body := map[string]any{"config": map[string]any{"workingDir": cwd, "date": time.Now().UTC().Format("2006-01-02"), "environment": runtime.GOOS + "-" + runtime.GOARCH + ", " + runtime.Version(), "structure": []any{}, "isGitRepo": false, "currentBranch": "", "mainBranch": "", "gitStatus": "", "recentCommits": []any{}}, "memory": nil, "taste": nil, "skills": nil, "params": params}
	if options.SessionID == "" {
		body["threadId"] = uuid.NewString()
	} else if _, err := uuid.Parse(options.SessionID); err == nil {
		body["threadId"] = options.SessionID
	}
	return body, nil
}
