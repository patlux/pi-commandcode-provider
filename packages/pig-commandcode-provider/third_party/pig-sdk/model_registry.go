package sdk

import (
	"fmt"
	"slices"
)

// ProviderAuthStatus identifies the configured credential source without exposing secrets.
type ProviderAuthStatus struct {
	Configured bool   `json:"configured"`
	Source     string `json:"source,omitempty"`
	Label      string `json:"label,omitempty"`
}

type registryProviderState struct {
	Name              string             `json:"name"`
	BaseURL           string             `json:"baseUrl"`
	AuthStatus        ProviderAuthStatus `json:"authStatus"`
	Configured        bool               `json:"configured"`
	UsingOAuth        bool               `json:"usingOAuth"`
	AvailableModelIDs *[]string          `json:"availableModelIds"`
}

type registryState struct {
	Models []map[string]any `json:"models"`
	// TypedModels are the image and classifier models; Models holds the chat models only.
	TypedModels []map[string]any                 `json:"typedModels"`
	Providers   map[string]registryProviderState `json:"providers"`
	Error       *string                          `json:"error"`
	Registered  []struct {
		Name   string                     `json:"name"`
		Config ProviderConfig             `json:"config"`
		Native *providerObjectDeclaration `json:"native,omitempty"`
	} `json:"registered"`
}

func (r ModelRegistry) state() (registryState, error) {
	return hostValue[registryState](r.context, "getModelRegistryState", nil)
}

func (r ModelRegistry) GetAll() ([]map[string]any, error) {
	state, err := r.state()
	return state.Models, err
}
func (r ModelRegistry) GetAvailable() ([]map[string]any, error) {
	state, err := r.state()
	if err != nil {
		return nil, err
	}
	models := []map[string]any{}
	for _, model := range state.Models {
		provider, _ := model["provider"].(string)
		id, _ := model["id"].(string)
		state := state.Providers[provider]
		if state.Configured && (state.AvailableModelIDs == nil || slices.Contains(*state.AvailableModelIDs, id)) {
			models = append(models, model)
		}
	}
	return models, nil
}
func (r ModelRegistry) GetError() (*string, error) {
	state, err := r.state()
	return state.Error, err
}
func (r ModelRegistry) HasConfiguredAuth(model map[string]any) (bool, error) {
	state, err := r.state()
	provider, _ := model["provider"].(string)
	return state.Providers[provider].Configured, err
}
func (r ModelRegistry) IsUsingOAuth(model map[string]any) (bool, error) {
	state, err := r.state()
	provider, _ := model["provider"].(string)
	return state.Providers[provider].UsingOAuth, err
}
func (r ModelRegistry) GetProviderAuthStatus(provider string) (ProviderAuthStatus, error) {
	state, err := r.state()
	return state.Providers[provider].AuthStatus, err
}
func (r ModelRegistry) GetProviderDisplayName(provider string) (string, error) {
	state, err := r.state()
	if p, ok := state.Providers[provider]; ok {
		return p.Name, err
	}
	return provider, err
}
func (r ModelRegistry) GetProviderAuth(provider string) (map[string]any, error) {
	return hostValue[map[string]any](r.context, "getProviderAuth", map[string]string{"provider": provider})
}

// GetApiKeyForProvider returns nil when auth resolution fails, as Pi does.
func (r ModelRegistry) GetApiKeyForProvider(provider string) *string {
	result, err := r.GetProviderAuth(provider)
	if err != nil {
		return nil
	}
	auth, _ := result["auth"].(map[string]any)
	key, ok := auth["apiKey"].(string)
	if !ok {
		return nil
	}
	return &key
}
func (r ModelRegistry) GetRegisteredProviderIDs() ([]string, error) {
	state, err := r.state()
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(state.Registered))
	for _, entry := range state.Registered {
		ids = append(ids, entry.Name)
	}
	return ids, nil
}
func (r ModelRegistry) GetRegisteredProviderConfig(provider string) (ProviderConfig, error) {
	state, err := r.state()
	if err != nil {
		return nil, err
	}
	for _, entry := range state.Registered {
		if entry.Name == provider {
			return entry.Config, nil
		}
	}
	return nil, nil
}

// RegisterProvider applies a provider config at once, as Pi's pi.registerProvider does after the factory finished (types.ts:1766-1803, runner.ts:517-523). The config carries its callbacks (streamSimple, images, classifiers, oauth) as a factory registration does: they stay in the extension and the call names them. A registration the host refuses leaves the callbacks the provider had.
func (r ModelRegistry) RegisterProvider(name string, config ProviderConfig) error {
	return r.context.ext.registerProviderNow(&r.context, nil, name, config)
}

// registerProviderNow sends a provider registration through the host: as part of request c, or on conn when no request makes it.
func (e *Extension) registerProviderNow(c *Context, conn *conn, name string, config ProviderConfig) error {
	kept, declaration, err := e.takeLateProviderDef(name, config)
	if err != nil {
		return fmt.Errorf("provider %s: encode config: %w", name, err)
	}
	result, err := hostCallFor(c, conn, "registerProvider", declaration)
	err = callResultError(result, err)
	if err != nil {
		e.providerMu.Lock()
		e.restoreHeldProviderCallbacks(name, kept)
		e.providerMu.Unlock()
	}
	return err
}

// takeLateProviderDef keeps a late registration's callbacks and returns what the extension held before. A panic for an invalid callback or a config JSON cannot encode leaves the held callbacks as they were and releases providerMu, as Pi validates a registration before it touches the stored one (model-runtime.ts registerProvider).
func (e *Extension) takeLateProviderDef(name string, config ProviderConfig) (kept heldCallbacks, declaration providerDef, err error) {
	e.providerMu.Lock()
	defer e.providerMu.Unlock()
	kept = e.heldProviderCallbacks(name)
	defer func() {
		if recovered := recover(); recovered != nil {
			e.restoreHeldProviderCallbacks(name, kept)
			panic(recovered)
		}
	}()
	declaration, err = e.takeProviderDef(name, config)
	if err != nil {
		e.restoreHeldProviderCallbacks(name, kept)
	}
	return kept, declaration, err
}

// UnregisterProvider removes a provider and, once the host removed it, drops the callbacks the extension held for it.
func (r ModelRegistry) UnregisterProvider(name string) error {
	return r.context.ext.unregisterProviderNow(&r.context, nil, name)
}

// unregisterProviderNow removes a provider through the host, as part of request c or on conn, and then drops the callbacks the extension held for it.
func (e *Extension) unregisterProviderNow(c *Context, conn *conn, name string) error {
	result, err := hostCallFor(c, conn, "unregisterProvider", map[string]string{"name": name})
	if err = callResultError(result, err); err != nil {
		return err
	}
	e.providerMu.Lock()
	e.restoreHeldProviderCallbacks(name, heldCallbacks{})
	e.providerMu.Unlock()
	return nil
}

type ModelsRefreshOptions struct {
	AllowNetwork *bool    `json:"allowNetwork,omitempty"`
	Providers    []string `json:"providers,omitempty"`
	Force        *bool    `json:"force,omitempty"`
}
type ModelsRefreshResult struct {
	Aborted bool              `json:"aborted"`
	Errors  map[string]string `json:"errors"`
}

// Refresh waits for the host refresh and propagates cancellation through the handler context.
func (r ModelRegistry) Refresh(options ModelsRefreshOptions) (ModelsRefreshResult, error) {
	return hostValue[ModelsRefreshResult](r.context, "refreshModelRegistry", options)
}
