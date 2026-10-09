package sdk

import (
	"encoding/json"
	"errors"
)

// SessionManager reads the active host session. Each call completes before returning;
// host and transport failures are returned rather than replaced by empty state.
type SessionManager struct{ context Context }

func (c Context) SessionManager() SessionManager { return SessionManager{context: c} }

func hostValue[T any](c Context, method string, args any) (T, error) {
	var value T
	result, err := c.callHost(method, args)
	if err := callResultError(result, err); err != nil {
		return value, err
	}
	if result == nil {
		return value, errors.New("host returned no result")
	}
	if err := json.Unmarshal(result.Result, &value); err != nil {
		return value, err
	}
	return value, nil
}

func sessionValue[T any](s SessionManager, method string, args any) (T, error) {
	return hostValue[T](s.context, "sessionRead", map[string]any{"method": method, "args": args})
}

func (s SessionManager) GetCwd() (string, error) { return sessionValue[string](s, "getCwd", nil) }
func (s SessionManager) GetSessionDir() (string, error) {
	return sessionValue[string](s, "getSessionDir", nil)
}
func (s SessionManager) GetSessionID() (string, error) {
	return sessionValue[string](s, "getSessionId", nil)
}
func (s SessionManager) GetSessionFile() (*string, error) {
	return sessionValue[*string](s, "getSessionFile", nil)
}
func (s SessionManager) GetSessionName() (*string, error) {
	return sessionValue[*string](s, "getSessionName", nil)
}
func (s SessionManager) GetLeafID() (*string, error) {
	return sessionValue[*string](s, "getLeafId", nil)
}
func (s SessionManager) GetHeader() (map[string]any, error) {
	return sessionValue[map[string]any](s, "getHeader", nil)
}
func (s SessionManager) GetLeafEntry() (map[string]any, error) {
	return sessionValue[map[string]any](s, "getLeafEntry", nil)
}
func (s SessionManager) GetEntry(id string) (map[string]any, error) {
	return sessionValue[map[string]any](s, "getEntry", map[string]string{"id": id})
}
func (s SessionManager) GetLabel(id string) (*string, error) {
	return sessionValue[*string](s, "getLabel", map[string]string{"id": id})
}
func (s SessionManager) GetEntries() ([]map[string]any, error) {
	return sessionValue[[]map[string]any](s, "getEntries", nil)
}
func (s SessionManager) GetBranch(fromID *string) ([]map[string]any, error) {
	return sessionValue[[]map[string]any](s, "getBranch", map[string]any{"fromId": fromID})
}
func (s SessionManager) GetChildren(parentID *string) ([]map[string]any, error) {
	return sessionValue[[]map[string]any](s, "getChildren", map[string]any{"parentId": parentID})
}
func (s SessionManager) GetTree() ([]SessionTreeNode, error) {
	return sessionValue[[]SessionTreeNode](s, "getTree", nil)
}
func (s SessionManager) BuildContextEntries() ([]map[string]any, error) {
	return sessionValue[[]map[string]any](s, "buildContextEntries", nil)
}
func (s SessionManager) BuildSessionProjection() (SessionProjection, error) {
	return sessionValue[SessionProjection](s, "buildSessionProjection", nil)
}
func (s SessionManager) BuildSessionContext() (SessionContext, error) {
	return sessionValue[SessionContext](s, "buildSessionContext", nil)
}
func (s SessionManager) IsPersisted() (bool, error) { return sessionValue[bool](s, "isPersisted", nil) }
func (s SessionManager) UsesDefaultSessionDir() (bool, error) {
	return sessionValue[bool](s, "usesDefaultSessionDir", nil)
}

type SessionTreeNode struct {
	Entry          map[string]any    `json:"entry"`
	Children       []SessionTreeNode `json:"children"`
	Label          *string           `json:"label,omitempty"`
	LabelTimestamp *string           `json:"labelTimestamp,omitempty"`
}
type SessionContext struct {
	Messages      []map[string]any `json:"messages"`
	ThinkingLevel string           `json:"thinkingLevel"`
	Model         map[string]any   `json:"model"`
}
type ProjectedSessionEntry struct {
	SourceEntry map[string]any   `json:"sourceEntry"`
	Messages    []map[string]any `json:"messages"`
}
type SessionProjection struct {
	SessionContext
	Entries []ProjectedSessionEntry `json:"entries"`
}
