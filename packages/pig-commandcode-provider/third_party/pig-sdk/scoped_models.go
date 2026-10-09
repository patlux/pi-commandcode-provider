package sdk

import "encoding/json"

// ScopedModel is one resolved model and its optional thinking-level override.
type ScopedModel struct {
	Model         map[string]any `json:"model"`
	ThinkingLevel string         `json:"thinkingLevel,omitempty"`
}

// ScopedModels returns the current session scope in selection order. Host and decode errors propagate to the caller.
func (c Context) ScopedModels() ([]ScopedModel, error) {
	result, err := c.callHost("getScopedModels", nil)
	if err := callResultError(result, err); err != nil {
		return nil, err
	}
	var models []ScopedModel
	if result != nil {
		if err := json.Unmarshal(result.Result, &models); err != nil {
			return nil, err
		}
	}
	if models == nil {
		models = []ScopedModel{}
	}
	return models, nil
}
