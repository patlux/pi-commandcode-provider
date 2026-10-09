package sdk

// Ports packages/coding-agent/src/core/mcp-servers.ts (the ordered `env`, `headers` and `toolExposure` objects).

import (
	"bytes"
	"errors"
	"fmt"
	"slices"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// orderedMap is a string map that keeps its JSON key order, as a JavaScript object does. A repeated key keeps its first position and its last value.
type orderedMap struct {
	keys   []string
	values map[string]string
}

func newOrderedMap(pairs []string) orderedMap {
	var m orderedMap
	for i := 0; i+1 < len(pairs); i += 2 {
		m.set(pairs[i], pairs[i+1])
	}
	return m
}

func (m *orderedMap) set(key, value string) {
	if m.values == nil {
		m.values = make(map[string]string)
	}
	if _, exists := m.values[key]; !exists {
		m.keys = append(m.keys, key)
	}
	m.values[key] = value
}

func (m orderedMap) get(key string) (string, bool) {
	value, ok := m.values[key]
	return value, ok
}

func (m orderedMap) marshal() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, key := range m.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		name, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		value, err := json.Marshal(m.values[key])
		if err != nil {
			return nil, err
		}
		buf.Write(name)
		buf.WriteByte(':')
		buf.Write(value)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// unmarshal reads an object whose values are all strings.
func (m *orderedMap) unmarshal(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	token, err := dec.Token()
	if err != nil {
		return err
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return errors.New("value is not an object")
	}
	var decoded orderedMap
	for dec.More() {
		keyToken, err := dec.Token()
		if err != nil {
			return err
		}
		key, ok := keyToken.(string)
		if !ok {
			return fmt.Errorf("unexpected key %v", keyToken)
		}
		valueToken, err := dec.Token()
		if err != nil {
			return err
		}
		value, ok := valueToken.(string)
		if !ok {
			return fmt.Errorf("value of %q is not a string", key)
		}
		decoded.set(key, value)
	}
	if _, err := dec.Token(); err != nil {
		return err
	}
	*m = decoded
	return nil
}

// OrderedStrings is a string map that keeps its JSON key order: the `env` and `headers` of an MCP server entry.
type OrderedStrings struct{ m orderedMap }

// NewOrderedStrings builds the map from alternating keys and values.
func NewOrderedStrings(pairs ...string) *OrderedStrings {
	return &OrderedStrings{m: newOrderedMap(pairs)}
}

// Keys returns the keys in order.
func (s *OrderedStrings) Keys() []string {
	if s == nil {
		return nil
	}
	return slices.Clone(s.m.keys)
}

// Get returns the value of key.
func (s *OrderedStrings) Get(key string) (string, bool) {
	if s == nil {
		return "", false
	}
	return s.m.get(key)
}

// MarshalJSON writes the keys in order.
func (s OrderedStrings) MarshalJSON() ([]byte, error) { return s.m.marshal() }

// UnmarshalJSON reads an object of strings.
func (s *OrderedStrings) UnmarshalJSON(data []byte) error { return s.m.unmarshal(data) }

// OrderedExposures maps tool names or patterns to exposures and keeps its JSON key order: among patterns the first match wins.
type OrderedExposures struct{ m orderedMap }

// NewOrderedExposures builds the map from alternating patterns and exposures.
func NewOrderedExposures(pairs ...string) *OrderedExposures {
	return &OrderedExposures{m: newOrderedMap(pairs)}
}

// Keys returns the patterns in order.
func (e *OrderedExposures) Keys() []string {
	if e == nil {
		return nil
	}
	return slices.Clone(e.m.keys)
}

// Get returns the exposure of a key.
func (e *OrderedExposures) Get(key string) (McpExposure, bool) {
	if e == nil {
		return "", false
	}
	value, ok := e.m.get(key)
	return McpExposure(value), ok
}

// MarshalJSON writes the keys in order.
func (e OrderedExposures) MarshalJSON() ([]byte, error) { return e.m.marshal() }

// UnmarshalJSON reads an object of exposures. The host validates the values.
func (e *OrderedExposures) UnmarshalJSON(data []byte) error { return e.m.unmarshal(data) }
