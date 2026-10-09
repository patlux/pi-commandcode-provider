package sdk

import (
	"bytes"
	"slices"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// marshalInSourceOrder encodes value with the object member order of the JSON text source, as a JavaScript object keeps the order of the members its handler edited: a member the source lists keeps its place, a member it does not list follows in sorted order, and a removed member is gone. A Go map has no insertion order, so the order of two members a handler added is sorted. An array is matched element by element.
func marshalInSourceOrder(value any, source json.RawMessage) ([]byte, error) {
	switch typed := value.(type) {
	case map[string]any:
		var sourceMembers map[string]json.RawMessage
		var sourceOrder []string
		if len(source) > 0 && source[0] == '{' {
			if err := json.Unmarshal(source, &sourceMembers); err != nil {
				sourceMembers = nil
			} else {
				sourceOrder = objectKeyOrder(source)
			}
		}
		keys := make([]string, 0, len(typed))
		for _, key := range sourceOrder {
			if _, ok := typed[key]; ok {
				keys = append(keys, key)
			}
		}
		var added []string
		for key := range typed {
			if !slices.Contains(keys, key) {
				added = append(added, key)
			}
		}
		slices.Sort(added)
		keys = append(keys, added...)
		var buf bytes.Buffer
		buf.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			name, err := json.Marshal(key)
			if err != nil {
				return nil, err
			}
			member, err := marshalInSourceOrder(typed[key], sourceMembers[key])
			if err != nil {
				return nil, err
			}
			buf.Write(name)
			buf.WriteByte(':')
			buf.Write(member)
		}
		buf.WriteByte('}')
		return buf.Bytes(), nil
	case []any:
		var sourceElements []json.RawMessage
		if len(source) > 0 && source[0] == '[' {
			if err := json.Unmarshal(source, &sourceElements); err != nil {
				sourceElements = nil
			}
		}
		var buf bytes.Buffer
		buf.WriteByte('[')
		for i, element := range typed {
			if i > 0 {
				buf.WriteByte(',')
			}
			var elementSource json.RawMessage
			if i < len(sourceElements) {
				elementSource = sourceElements[i]
			}
			encoded, err := marshalInSourceOrder(element, elementSource)
			if err != nil {
				return nil, err
			}
			buf.Write(encoded)
		}
		buf.WriteByte(']')
		return buf.Bytes(), nil
	}
	return json.Marshal(value)
}

// objectKeyOrder returns the keys of the JSON object text in the order it writes them.
func objectKeyOrder(object []byte) []string {
	decoder := json.NewDecoder(bytes.NewReader(object))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil
	}
	var keys []string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return keys
		}
		key, ok := token.(string)
		if !ok {
			return keys
		}
		keys = append(keys, key)
		var skipped json.RawMessage
		if err := decoder.Decode(&skipped); err != nil {
			return keys
		}
	}
	return keys
}
