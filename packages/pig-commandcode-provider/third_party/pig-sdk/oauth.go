package sdk

import (
	"encoding/json"
	"errors"
)

// OAuth bridge method names. These mirror the host wire contract
// (coding/extension/host/subprocess/protocol.go); the SDK is a separate module
// and cannot import it, so the string values are duplicated and must match.
const (
	methodOAuthLogin             = "oauth_login"
	methodOAuthRefresh           = "oauth_refresh"
	methodOAuthGetAPIKey         = "oauth_get_api_key"
	methodOAuthCredentialStatus  = "oauth_credential_status"
	methodOAuthStoreCredentials  = "oauth_store_credentials"
	methodOAuthDeleteCredentials = "oauth_delete_credentials"

	callOAuthOnAuth            = "oauth.cb.onAuth"
	callOAuthOnDeviceCode      = "oauth.cb.onDeviceCode"
	callOAuthOnProgress        = "oauth.cb.onProgress"
	callOAuthOnPrompt          = "oauth.cb.onPrompt"
	callOAuthOnSelect          = "oauth.cb.onSelect"
	callOAuthOnManualCodeInput = "oauth.cb.onManualCodeInput"
)

// ErrOAuthCancelled is returned by a value-returning login callback when the
// user dismissed the host prompt.
var ErrOAuthCancelled = errors.New("oauth prompt cancelled")

// OAuthCredentials is Pi's OAuth token object (packages/ai/src/auth/types.ts OAuthCredentials). The JSON tags are the wire shape shared with the host and core (ai.OAuthCredentials).
//
// The six named fields keep their original order; fields added for Pi's complete token object follow them.
type OAuthCredentials struct {
	Refresh string `json:"refresh"`
	Access  string `json:"access"`
	// Expires is the truncated integer projection of expires in Unix milliseconds. ExpiresMillis reads Pi's exact JavaScript number, including a fraction or an absent property; SetExpiresMillis writes one. Assigning Expires replaces any retained exact value.
	Expires   int64  `json:"expires"`
	ProjectID string `json:"projectId,omitempty"`
	AccountID string `json:"accountId,omitempty"`
	Scope     string `json:"scope,omitempty"`
	// Extra retains every other provider-owned key, including a present empty or null value of a named optional field. Named fields take precedence when both are set.
	Extra map[string]json.RawMessage `json:"-"`

	expiry oauthExpiry
}

// OAuthAuthInfo, OAuthDeviceCodeInfo, OAuthPrompt, OAuthSelectPrompt, and
// OAuthSelectOption are the login-callback payloads. Their JSON tags are the
// wire shape, so callbacks send them directly.
type OAuthAuthInfo struct {
	URL          string `json:"url"`
	Instructions string `json:"instructions,omitempty"`
}

type OAuthDeviceCodeInfo struct {
	UserCode         string  `json:"userCode"`
	VerificationURI  string  `json:"verificationUri"`
	IntervalSeconds  float64 `json:"intervalSeconds,omitempty"`
	ExpiresInSeconds float64 `json:"expiresInSeconds,omitempty"`
}

type OAuthPrompt struct {
	Message     string `json:"message"`
	Placeholder string `json:"placeholder,omitempty"`
	AllowEmpty  bool   `json:"allowEmpty,omitempty"`
}

type OAuthSelectOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type OAuthSelectPrompt struct {
	Message string              `json:"message"`
	Options []OAuthSelectOption `json:"options"`
}

// OAuthCredentialStatus describes stored credentials for a provider.
type OAuthCredentialStatus struct {
	Present  bool   `json:"present"`
	AuthType string `json:"authType,omitempty"`
	Source   string `json:"source,omitempty"`
}

// OAuthCredentialStore lets a provider own credential persistence instead of
// core's auth.json. A provider that supplies one declares has_credential_store
// and the host routes status/store/delete to it.
type OAuthCredentialStore interface {
	CredentialStatus() OAuthCredentialStatus
	StoreCredentials(creds OAuthCredentials) (path string, err error)
	DeleteCredentials() (deleted bool, err error)
}

// OAuthProvider is an OAuth capability attached to a model provider under the
// "oauth" key of a [ProviderConfig]. The host builds a proxy that RPCs these
// closures. Only the non-nil closures are advertised as capabilities.
type OAuthProvider struct {
	// Name is informational; the registry key is the provider name passed to
	// RegisterProvider. Defaults to that name when empty.
	Name string

	// IsSubscription marks access through this OAuth method as subscription-backed.
	IsSubscription bool

	// Login runs the interactive login flow, driving the host UI through cb, and
	// returns the resulting credentials. Required.
	Login func(cb *OAuthLoginCallbacks) (OAuthCredentials, error)

	// RefreshToken exchanges refresh credentials for fresh ones. Optional.
	RefreshToken func(creds OAuthCredentials) (OAuthCredentials, error)

	// GetAPIKey resolves the bearer to send for a set of credentials. Optional;
	// when absent the access token is used directly.
	GetAPIKey func(creds OAuthCredentials) string

	// CredentialStore, when set, makes the provider own credential persistence.
	CredentialStore OAuthCredentialStore
}

// providerOAuthConfig is the serializable capability descriptor placed under the
// "oauth" key of the provider config on the wire. Matches ProviderOAuthConfig.
type providerOAuthConfig struct {
	Name               string `json:"name"`
	IsSubscription     bool   `json:"isSubscription,omitempty"`
	HasLogin           bool   `json:"has_login"`
	HasRefresh         bool   `json:"has_refresh"`
	HasGetAPIKey       bool   `json:"has_get_api_key"`
	HasModifyModels    bool   `json:"has_modify_models,omitempty"`
	HasCredentialStore bool   `json:"has_credential_store,omitempty"`
}

type oauthAPIKeyResult struct {
	APIKey string `json:"apiKey"`
}

type oauthInputResult struct {
	Value  string `json:"value"`
	Cancel bool   `json:"cancel,omitempty"`
}

type oauthCredentialStatusResult struct {
	Present  bool   `json:"present"`
	AuthType string `json:"authType,omitempty"`
	Source   string `json:"source,omitempty"`
}

type oauthStoreResult struct {
	Path string `json:"path"`
}

type oauthDeleteResult struct {
	Deleted bool `json:"deleted"`
}

// OAuthLoginCallbacks drives the host login UI from inside a provider's Login
// closure. Each method issues an oauth.cb.* call to the host; value-returning
// methods block until the user responds.
type OAuthLoginCallbacks struct {
	conn      *conn
	requestID string
}

// OnAuth reports an authorization URL to open. Fire-and-forget.
func (cb *OAuthLoginCallbacks) OnAuth(info OAuthAuthInfo) {
	_, _ = cb.conn.callFor(cb.requestID, callOAuthOnAuth, info)
	_ = cb.conn.requestState(cb.requestID, "progress", "")
}

// OnDeviceCode reports device-code details to display. Fire-and-forget.
func (cb *OAuthLoginCallbacks) OnDeviceCode(info OAuthDeviceCodeInfo) {
	_, _ = cb.conn.callFor(cb.requestID, callOAuthOnDeviceCode, info)
	_ = cb.conn.requestState(cb.requestID, "progress", "")
}

// OnProgress reports a status line during login. Fire-and-forget.
func (cb *OAuthLoginCallbacks) OnProgress(message string) {
	_, _ = cb.conn.callFor(cb.requestID, callOAuthOnProgress, OAuthProgress{Message: message})
	_ = cb.conn.requestState(cb.requestID, "progress", "")
}

// OnPrompt asks the user for free-text input. Returns [ErrOAuthCancelled] if the
// user dismissed the prompt.
func (cb *OAuthLoginCallbacks) OnPrompt(prompt OAuthPrompt) (string, error) {
	return cb.inputCall(callOAuthOnPrompt, prompt)
}

// OnSelect asks the user to choose an option. Returns [ErrOAuthCancelled] if the
// user dismissed the prompt.
func (cb *OAuthLoginCallbacks) OnSelect(prompt OAuthSelectPrompt) (string, error) {
	return cb.inputCall(callOAuthOnSelect, prompt)
}

// OnManualCodeInput asks the user to paste a code. Returns [ErrOAuthCancelled]
// if the user dismissed the prompt.
func (cb *OAuthLoginCallbacks) OnManualCodeInput() (string, error) {
	return cb.inputCall(callOAuthOnManualCodeInput, nil)
}

// OAuthProgress is the wire payload for OnProgress.
type OAuthProgress struct {
	Message string `json:"message"`
}

func (cb *OAuthLoginCallbacks) inputCall(method string, args any) (string, error) {
	_ = cb.conn.requestState(cb.requestID, "blocked", "user")
	result, err := cb.conn.callFor(cb.requestID, method, args)
	_ = cb.conn.requestState(cb.requestID, "progress", "")
	if err != nil {
		return "", err
	}
	if result == nil {
		return "", errors.New("oauth callback returned no result")
	}
	if result.Error != nil {
		return "", errors.New(result.Error.Message)
	}
	var inp oauthInputResult
	if err := json.Unmarshal(result.Result, &inp); err != nil {
		return "", err
	}
	if inp.Cancel {
		return "", ErrOAuthCancelled
	}
	return inp.Value, nil
}

// registerOAuthProvider stores a provider's closures for oauth_* dispatch.
func (e *Extension) registerOAuthProvider(name string, provider *OAuthProvider) {
	if e.oauthProviders == nil {
		e.oauthProviders = make(map[string]*OAuthProvider)
	}
	e.oauthProviders[name] = provider
}

// oauthConfigFor builds the serializable capability descriptor for a provider.
func oauthConfigFor(name string, provider *OAuthProvider) providerOAuthConfig {
	declaredName := provider.Name
	if declaredName == "" {
		declaredName = name
	}
	return providerOAuthConfig{
		Name:               declaredName,
		IsSubscription:     provider.IsSubscription,
		HasLogin:           provider.Login != nil,
		HasRefresh:         provider.RefreshToken != nil,
		HasGetAPIKey:       provider.GetAPIKey != nil,
		HasCredentialStore: provider.CredentialStore != nil,
	}
}

// dispatchOAuth routes an oauth_* request to the provider named by req.Tool.
func (e *Extension) dispatchOAuth(id string, req *requestMsg) {
	e.providerMu.RLock()
	provider := e.oauthProviders[req.Tool]
	e.providerMu.RUnlock()
	if provider == nil {
		_ = e.conn.respond(id, nil, errors.New("unknown oauth provider: "+req.Tool))
		return
	}
	switch req.Method {
	case methodOAuthLogin:
		if provider.Login == nil {
			_ = e.conn.respond(id, nil, errors.New("provider does not support login"))
			return
		}
		creds, err := provider.Login(&OAuthLoginCallbacks{conn: e.conn, requestID: id})
		_ = e.conn.respond(id, creds, err)

	case methodOAuthRefresh:
		if provider.RefreshToken == nil {
			_ = e.conn.respond(id, nil, errors.New("provider does not support refresh"))
			return
		}
		creds, err := provider.RefreshToken(decodeCreds(req.Args))
		_ = e.conn.respond(id, creds, err)

	case methodOAuthGetAPIKey:
		key := ""
		if provider.GetAPIKey != nil {
			key = provider.GetAPIKey(decodeCreds(req.Args))
		}
		_ = e.conn.respond(id, oauthAPIKeyResult{APIKey: key}, nil)

	case methodOAuthCredentialStatus:
		store, ok := e.oauthStore(id, provider)
		if !ok {
			return
		}
		st := store.CredentialStatus()
		_ = e.conn.respond(id, oauthCredentialStatusResult(st), nil)

	case methodOAuthStoreCredentials:
		store, ok := e.oauthStore(id, provider)
		if !ok {
			return
		}
		path, err := store.StoreCredentials(decodeCreds(req.Args))
		_ = e.conn.respond(id, oauthStoreResult{Path: path}, err)

	case methodOAuthDeleteCredentials:
		store, ok := e.oauthStore(id, provider)
		if !ok {
			return
		}
		deleted, err := store.DeleteCredentials()
		_ = e.conn.respond(id, oauthDeleteResult{Deleted: deleted}, err)

	default:
		_ = e.conn.respond(id, nil, errors.New("unknown oauth method: "+req.Method))
	}
}

func (e *Extension) oauthStore(id string, provider *OAuthProvider) (OAuthCredentialStore, bool) {
	if provider.CredentialStore == nil {
		_ = e.conn.respond(id, nil, errors.New("provider has no credential store"))
		return nil, false
	}
	return provider.CredentialStore, true
}

func decodeCreds(args json.RawMessage) OAuthCredentials {
	var creds OAuthCredentials
	if len(args) > 0 {
		_ = json.Unmarshal(args, &creds)
	}
	return creds
}
