package commandcode

// Match the TypeScript generate transport's Gemini policy. PiG supplies JSON
// Schema already; only traverse schema-valued keywords, never literal data.
func geminiSafeSchema(value any) any {
	switch value := value.(type) {
	case []any:
		out := make([]any, len(value))
		for i, item := range value {
			out[i] = geminiSafeSchema(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(value))
		for key, child := range value {
			if key == "default" && child == nil {
				continue
			}
			switch key {
			case "$defs", "definitions", "dependentSchemas", "patternProperties", "properties":
				if entries, ok := child.(map[string]any); ok {
					converted := make(map[string]any, len(entries))
					for name, schema := range entries {
						converted[name] = geminiSafeSchema(schema)
					}
					out[key] = converted
					continue
				}
			case "allOf", "anyOf", "oneOf", "prefixItems", "additionalItems", "additionalProperties", "contains", "contentSchema", "else", "if", "items", "not", "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties":
				out[key] = geminiSafeSchema(child)
				continue
			}
			out[key] = cloneJSON(child)
		}
		if types, ok := value["type"].([]any); ok {
			nonNull := []string{}
			hasNull, valid := false, true
			for _, entry := range types {
				name, ok := entry.(string)
				if !ok {
					valid = false
					break
				}
				if name == "null" {
					hasNull = true
				} else {
					nonNull = append(nonNull, name)
				}
			}
			if valid && hasNull && len(nonNull) == 1 {
				out["type"], out["nullable"] = nonNull[0], true
			}
		}
		return out
	default:
		return value
	}
}
