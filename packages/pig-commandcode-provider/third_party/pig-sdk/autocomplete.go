package sdk

import (
	"crypto/rand"
	"errors"
	"fmt"
	"runtime"
	"sync"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// AutocompleteSuggestions is the complete provider answer. Cursor columns in this API count UTF-16 code units, as in Pi.
type AutocompleteSuggestions struct {
	Items  []AutocompleteItem `json:"items"`
	Prefix string             `json:"prefix"`
}

// AutocompleteCompletion replaces the buffer and its cursor after selection.
type AutocompleteCompletion struct {
	Lines      []string `json:"lines"`
	CursorLine int      `json:"cursorLine"`
	CursorCol  int      `json:"cursorCol"`
}

// AutocompleteProvider wraps the current provider. Each callback receives its live request context; mutable provider state belongs to the returned instance.
type AutocompleteProvider struct {
	TriggerCharacters           []string
	GetSuggestions              func(Context, []string, int, int, bool) (*AutocompleteSuggestions, error)
	ApplyCompletion             func(Context, []string, int, int, AutocompleteItem, string) (AutocompleteCompletion, error)
	ShouldTriggerFileCompletion func(Context, []string, int, int) (bool, error)
}

// AutocompleteProviderFactory runs when the host rebuilds the provider chain, not on each query.
type AutocompleteProviderFactory func(Context, *AutocompleteProvider) (*AutocompleteProvider, error)

type autocompleteRegistry struct {
	mu        sync.Mutex
	factories map[string]AutocompleteProviderFactory
	providers map[string]*AutocompleteProvider
	invoked   map[string]bool
}

type autocompleteDescriptor struct {
	ID                string   `json:"id"`
	TriggerCharacters []string `json:"triggerCharacters"`
	HasFileTrigger    bool     `json:"hasFileTrigger"`
}

type autocompleteInvocation struct {
	ID         string                 `json:"id"`
	FactoryID  string                 `json:"factoryId,omitempty"`
	Current    autocompleteDescriptor `json:"current"`
	Operation  string                 `json:"operation"`
	Lines      []string               `json:"lines"`
	CursorLine int                    `json:"cursorLine"`
	CursorCol  int                    `json:"cursorCol"`
	Force      bool                   `json:"force"`
	Item       AutocompleteItem       `json:"item"`
	Prefix     string                 `json:"prefix"`
}

// AddAutocompleteProvider appends a factory and waits until the host installs its rebuilt chain. Headless contexts do not call or retain the factory.
func (c Context) AddAutocompleteProvider(factory AutocompleteProviderFactory) error {
	if !c.HasUI() {
		return nil
	}
	if factory == nil {
		return errors.New("autocomplete factory is missing")
	}
	registry := &c.ext.autocomplete
	id := rand.Text()
	registry.mu.Lock()
	if registry.factories == nil {
		registry.factories = make(map[string]AutocompleteProviderFactory)
	}
	registry.factories[id] = factory
	if registry.invoked == nil {
		registry.invoked = make(map[string]bool)
	}
	registry.mu.Unlock()
	result, err := c.callHost("ui.addAutocompleteProvider", map[string]string{"factoryId": id})
	registry.mu.Lock()
	if !registry.invoked[id] {
		delete(registry.factories, id)
	}
	registry.mu.Unlock()
	return callResultError(result, err)
}

type autocompleteLease struct {
	owner *Extension
	id    string
}
type autocompleteLeaseCleanup struct {
	conn *conn
	id   string
}

func releaseAutocompleteLease(lease autocompleteLeaseCleanup) {
	_ = lease.conn.notify("ui.autocomplete.release", map[string]string{"id": lease.id})
}

func autocompleteCall[T any](ctx Context, lease *autocompleteLease, request autocompleteInvocation) (result T, err error) {
	defer runtime.KeepAlive(lease)
	request.ID = lease.id
	if ctx.ext != lease.owner {
		ctx.ext = lease.owner
		ctx.requestID = ""
	}
	if err = ctx.Err(); err != nil {
		return result, err
	}
	response, err := ctx.callHost("ui.autocomplete.invoke", request)
	if err = callResultError(response, err); err != nil {
		return result, err
	}
	if response == nil {
		return result, errors.New("missing autocomplete response")
	}
	err = json.Unmarshal(response.Result, &result)
	return result, err
}

func autocompleteProxy(ctx Context, desc autocompleteDescriptor) *AutocompleteProvider {
	lease := &autocompleteLease{owner: ctx.ext, id: desc.ID}
	runtime.AddCleanup(lease, releaseAutocompleteLease, autocompleteLeaseCleanup{conn: ctx.ext.conn, id: desc.ID})
	provider := &AutocompleteProvider{TriggerCharacters: desc.TriggerCharacters}
	provider.GetSuggestions = func(ctx Context, lines []string, line, col int, force bool) (*AutocompleteSuggestions, error) {
		return autocompleteCall[*AutocompleteSuggestions](ctx, lease, autocompleteInvocation{Operation: "getSuggestions", Lines: lines, CursorLine: line, CursorCol: col, Force: force})
	}
	provider.ApplyCompletion = func(ctx Context, lines []string, line, col int, item AutocompleteItem, prefix string) (AutocompleteCompletion, error) {
		return autocompleteCall[AutocompleteCompletion](ctx, lease, autocompleteInvocation{Operation: "applyCompletion", Lines: lines, CursorLine: line, CursorCol: col, Item: item, Prefix: prefix})
	}
	if desc.HasFileTrigger {
		provider.ShouldTriggerFileCompletion = func(ctx Context, lines []string, line, col int) (bool, error) {
			return autocompleteCall[bool](ctx, lease, autocompleteInvocation{Operation: "shouldTriggerFileCompletion", Lines: lines, CursorLine: line, CursorCol: col})
		}
	}
	return provider
}

func (e *Extension) dispatchAutocomplete(ctx Context, raw json.RawMessage) (any, error) {
	var request autocompleteInvocation
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, err
	}
	registry := &e.autocomplete
	registry.mu.Lock()
	factory, provider := registry.factories[request.FactoryID], registry.providers[request.ID]
	if request.Operation == "wrap" && factory != nil {
		registry.invoked[request.FactoryID] = true
	}
	registry.mu.Unlock()
	if request.Operation == "wrap" {
		if factory == nil {
			return nil, errors.New("autocomplete factory is no longer available")
		}
		provider, err := factory(ctx, autocompleteProxy(ctx, request.Current))
		if err != nil {
			return nil, err
		}
		if provider == nil || provider.GetSuggestions == nil || provider.ApplyCompletion == nil {
			return nil, errors.New("autocomplete factory must return a provider")
		}
		id := rand.Text()
		registry.mu.Lock()
		if registry.providers == nil {
			registry.providers = make(map[string]*AutocompleteProvider)
		}
		registry.providers[id] = provider
		registry.mu.Unlock()
		return autocompleteDescriptor{ID: id, TriggerCharacters: provider.TriggerCharacters, HasFileTrigger: provider.ShouldTriggerFileCompletion != nil}, nil
	}
	if provider == nil {
		return nil, errors.New("autocomplete provider is no longer available")
	}
	switch request.Operation {
	case "getSuggestions":
		return provider.GetSuggestions(ctx, request.Lines, request.CursorLine, request.CursorCol, request.Force)
	case "applyCompletion":
		return provider.ApplyCompletion(ctx, request.Lines, request.CursorLine, request.CursorCol, request.Item, request.Prefix)
	case "shouldTriggerFileCompletion":
		if provider.ShouldTriggerFileCompletion == nil {
			return true, nil
		}
		return provider.ShouldTriggerFileCompletion(ctx, request.Lines, request.CursorLine, request.CursorCol)
	default:
		return nil, fmt.Errorf("unknown autocomplete operation %q", request.Operation)
	}
}
