package sdk

import (
	"encoding/json"
	"maps"
)

// userBashEventResult retains a present undefined exit code across JSON. Native nil represents the number-or-undefined field; pre-encoded JSON null remains null.
func userBashEventResult(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	switch value.(type) {
	case json.RawMessage, *json.RawMessage:
		return value, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(encoded, &object); err != nil {
			return value, nil
		}
	}
	result, ok := object["result"].(map[string]any)
	if !ok {
		return value, nil
	}
	object = maps.Clone(object)
	result = maps.Clone(result)
	exitCode, present := result["exitCode"]
	undefined := present && exitCode == nil
	object["_pigUserBashExitCodeUndefined"] = undefined
	if undefined {
		delete(result, "exitCode")
	}
	if path, present := result["fullOutputPath"]; present && path == nil {
		delete(result, "fullOutputPath")
	}
	object["result"] = result
	return object, nil
}
