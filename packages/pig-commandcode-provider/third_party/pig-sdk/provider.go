package sdk

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
)

// Provider is Pi's callable provider object. The ModelRegistry resolves credentials and normalizes transcripts separately from these methods.
type Provider struct {
	handle         string
	ID             string
	Name           string
	BaseURL        *string
	Headers        map[string]string
	Auth           ProviderAuth
	GetModels      func() ([]map[string]any, error)
	FilterModels   func([]map[string]any, map[string]any) ([]map[string]any, error)
	RefreshModels  func(RefreshModelsContext) error
	Stream         ProviderStreamFunc
	StreamSimple   ProviderStreamFunc
	FetchDeferred  ProviderStreamFunc
	CancelDeferred func(map[string]any, map[string]any, ProviderStreamOptions) error
	// GenerateImages and Classify are the provider's image and classifier operations. The models they serve come from GetModels.
	GenerateImages ProviderImagesFunc
	Classify       ProviderClassifyFunc
}

type ProviderStreamFunc func(model, transcriptOrHandle map[string]any, options ProviderStreamOptions) (*ModelEventStream, error)

type ProviderStreamOptions struct {
	Signal     context.Context
	Values     map[string]any
	OnPayload  func(any, map[string]any) (any, error)
	OnResponse func(map[string]any, map[string]any) error
	// OnProviderStreamEvent observes parsed provider data before normalization.
	OnProviderStreamEvent func(any, map[string]any) error
	TransformHeaders      func(map[string]string) (map[string]string, error)
}

type ProviderAuth struct {
	APIKey *APIKeyAuth
	OAuth  *OAuthAuth
}
type APIKeyAuth struct {
	Name    string
	Check   func(APIKeyAuthInput) (*AuthCheck, error)
	Resolve func(APIKeyAuthInput) (*AuthResult, error)
	Login   func(AuthInteraction) (map[string]any, error)
}
type OAuthAuth struct {
	Name           string
	IsSubscription *bool
	LoginLabel     *string
	Login          func(AuthInteraction) (map[string]any, error)
	Refresh        func(map[string]any, context.Context) (map[string]any, error)
	ToAuth         func(map[string]any) (map[string]any, error)
}
type AuthContext struct {
	Env        func(string) (*string, error)
	FileExists func(string) (bool, error)
}
type APIKeyAuthInput struct {
	Ctx        AuthContext
	Credential map[string]any
	Signal     context.Context
}
type AuthResult struct {
	Auth   map[string]any    `json:"auth"`
	Env    map[string]string `json:"env,omitempty"`
	Source *string           `json:"source,omitempty"`
}
type AuthCheck struct {
	Type   string  `json:"type"`
	Source *string `json:"source,omitempty"`
}
type AuthInteraction struct {
	Signal context.Context
	Prompt func(map[string]any) (string, error)
	Notify func(map[string]any) error
}
type ModelsPublication struct {
	// Persist preserves omission (nil), deletion (JSON null), and an explicit catalog.
	Persist json.RawMessage
	Update  func() error
}
type RefreshModelsContext struct {
	Credential   map[string]any
	Stored       map[string]any
	AllowNetwork bool
	Force        *bool
	Signal       context.Context
	Publish      func(ModelsPublication) (bool, error)
}

type providerObjectAuthMethod struct {
	Name           string  `json:"name"`
	IsSubscription *bool   `json:"isSubscription,omitempty"`
	LoginLabel     *string `json:"loginLabel,omitempty"`
}
type providerObjectAuth struct {
	APIKey *providerObjectAuthMethod `json:"apiKey,omitempty"`
	OAuth  *providerObjectAuthMethod `json:"oauth,omitempty"`
}
type providerObjectDeclaration struct {
	lease   *providerLease
	ID      string               `json:"id"`
	Key     string               `json:"key"`
	Handle  string               `json:"handle,omitempty"`
	Name    string               `json:"name"`
	BaseURL *string              `json:"baseUrl,omitempty"`
	Headers *map[string]string   `json:"headers,omitempty"`
	Auth    providerObjectAuth   `json:"auth"`
	Models  []map[string]any     `json:"models"`
	Methods []string             `json:"methods"`
	OAuth   *providerOAuthConfig `json:"oauth,omitempty"`
}

func providerDeclaration(provider *Provider, key string) (providerObjectDeclaration, error) {
	if provider == nil || strings.TrimSpace(provider.ID) == "" {
		return providerObjectDeclaration{}, errors.New("Provider id must not be empty")
	}
	if provider.GetModels == nil || provider.Stream == nil || provider.StreamSimple == nil {
		return providerObjectDeclaration{}, errors.New("Provider requires getModels, stream and streamSimple")
	}
	decl := providerObjectDeclaration{ID: provider.ID, Key: key, Name: provider.Name, BaseURL: provider.BaseURL, Methods: []string{"getModels", "stream", "streamSimple"}}
	if provider.Headers != nil {
		decl.Headers = &provider.Headers
	}
	// Models treats a throwing getModels as an empty catalog; calling the object directly still returns its error.
	decl.Models, _ = provider.GetModels()
	if decl.Models == nil {
		decl.Models = []map[string]any{}
	}
	for _, entry := range []struct {
		method  string
		present bool
	}{{"filterModels", provider.FilterModels != nil}, {"refreshModels", provider.RefreshModels != nil}, {"fetchDeferred", provider.FetchDeferred != nil}, {"cancelDeferred", provider.CancelDeferred != nil}, {"generateImages", provider.GenerateImages != nil}, {"classify", provider.Classify != nil}} {
		if entry.present {
			decl.Methods = append(decl.Methods, entry.method)
		}
	}
	if auth := provider.Auth.APIKey; auth != nil {
		if auth.Resolve == nil {
			return decl, errors.New("API key auth requires resolve")
		}
		decl.Auth.APIKey = &providerObjectAuthMethod{Name: auth.Name}
		decl.Methods = append(decl.Methods, "auth.apiKey.resolve")
		if auth.Check != nil {
			decl.Methods = append(decl.Methods, "auth.apiKey.check")
		}
		if auth.Login != nil {
			decl.Methods = append(decl.Methods, "auth.apiKey.login")
		}
	}
	if auth := provider.Auth.OAuth; auth != nil {
		if auth.Login == nil || auth.Refresh == nil || auth.ToAuth == nil {
			return decl, errors.New("OAuth auth requires login, refresh and toAuth")
		}
		decl.Auth.OAuth = &providerObjectAuthMethod{Name: auth.Name, IsSubscription: auth.IsSubscription, LoginLabel: auth.LoginLabel}
		decl.OAuth = &providerOAuthConfig{Name: auth.Name, IsSubscription: auth.IsSubscription != nil && *auth.IsSubscription, HasLogin: true, HasRefresh: true, HasGetAPIKey: true}
		decl.Methods = append(decl.Methods, "auth.oauth.login", "auth.oauth.refresh", "auth.oauth.toAuth")
	}
	if decl.Auth.APIKey == nil && decl.Auth.OAuth == nil {
		return decl, errors.New("Provider requires auth")
	}
	return decl, nil
}

// RegisterNativeProvider is the Provider-object overload of Pi's registerProvider.
func (e *Extension) RegisterNativeProvider(provider *Provider) error {
	decl, err := providerDeclaration(provider, rand.Text())
	if err != nil {
		return err
	}
	e.providerMu.Lock()
	if e.nativeProviders == nil {
		e.nativeProviders = map[string]*Provider{}
	}
	e.nativeProviders[decl.Key] = provider
	e.providerMu.Unlock()
	e.dropQueuedProvider(provider.ID)
	e.providers = append(e.providers, providerDef{Name: provider.ID, Config: json.RawMessage("{}"), Native: &decl})
	return nil
}

// CreateAssistantMessageEventStream creates a Provider-owned Event Stream.
func CreateAssistantMessageEventStream() *ModelEventStream { return newModelEventStream() }

// Push publishes an event in source order. A terminal event completes Result and closes Events.
func (s *ModelEventStream) Push(event map[string]any) { s.push(event) }
