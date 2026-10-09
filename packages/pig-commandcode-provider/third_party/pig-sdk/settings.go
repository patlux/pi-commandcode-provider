package sdk

// Ports packages/coding-agent/src/core/extensions/loader.ts (getSettings).

import (
	"errors"
	"fmt"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// Settings is the effective settings object [Context.GetSettings] returns: the JSON object of the global and project settings merged, with overrides.
//
// upstream: settings-manager.ts (Settings)
type Settings = map[string]any

// GetSettings returns a copy of the effective settings, as the host replicated them with its last state update. A host that has not bound its settings sends none, and the call fails as upstream's not-initialized getter does.
//
// upstream: loader.ts:411-414 (getSettings), types.ts:1708
func (c Context) GetSettings() (Settings, error) {
	c.ext.mu.RLock()
	raw := c.ext.settingsRaw
	c.ext.mu.RUnlock()
	if raw == nil {
		return nil, errors.New("the host sent no settings")
	}
	var settings Settings
	if err := json.Unmarshal(raw, &settings); err != nil {
		return nil, fmt.Errorf("decode the host's settings: %w", err)
	}
	if settings == nil {
		return nil, errors.New("the host's settings are not an object")
	}
	return settings, nil
}

// applyReplicatedState installs the settings and MCP server list of a state update at frame position at (see mcpServersAt). A state without one of them keeps the last value, and a value that is JSON null is no value. The caller holds e.mu.
func (e *Extension) applyReplicatedState(settings, mcpServers json.RawMessage, at uint64) {
	present := func(raw json.RawMessage) bool { return len(raw) > 0 && string(raw) != "null" }
	if present(settings) {
		e.settingsRaw = append(json.RawMessage(nil), settings...)
	}
	if present(mcpServers) && at >= e.mcpServersAt {
		e.mcpServersRaw = append(json.RawMessage(nil), mcpServers...)
		e.mcpServersAt = at
	}
}
