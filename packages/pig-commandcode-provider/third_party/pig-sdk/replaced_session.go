package sdk

import (
	"fmt"
	"maps"
	"sync"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// ReplacedSessionContext is Pi's ReplacedSessionContext (types.ts:442-452): the command context of the replacement Session that NewSession, Fork and SwitchSession pass to their withSession callback. Its host calls act on the replacement Session, and its SendMessage and SendUserMessage return after the Session operation, including the turn they trigger. Cwd, Mode, HasUI, the model getters, GetBranch and GetEntries answer for the replacement Session.
type ReplacedSessionContext struct {
	Context
}

// WithSessionFunc is the withSession option of NewSession, Fork and SwitchSession, passed under the "withSession" key. It runs after the replacement Session is bound and before the call returns; its error fails the call with the same error.
type WithSessionFunc func(ReplacedSessionContext) error

// requestWithSession runs a withSession callback (host protocol RequestWithSession).
const requestWithSession = "with_session"

// replacementState holds the values a replacement context answers locally, from the replacement Session's ready payload.
type replacementState struct {
	cwd           string
	mode          string
	hasUI         bool
	model         string
	modelProvider string
}

type withSessionEntry struct {
	callback WithSessionFunc
	mu       sync.Mutex
	err      error
}

func (e *withSessionEntry) fail(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.err = err
}

func (e *withSessionEntry) failure() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.err
}

// withSessionRegistry holds the withSession callbacks of replacement calls in flight, by the handle each call names.
type withSessionRegistry struct {
	mu      sync.Mutex
	next    uint64
	entries map[string]*withSessionEntry
}

func (r *withSessionRegistry) add(prefix string, callback WithSessionFunc) (string, *withSessionEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.entries == nil {
		r.entries = make(map[string]*withSessionEntry)
	}
	r.next++
	handle := fmt.Sprintf("%s:%d", prefix, r.next)
	entry := &withSessionEntry{callback: callback}
	r.entries[handle] = entry
	return handle, entry
}

func (r *withSessionRegistry) remove(handle string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, handle)
}

func (r *withSessionRegistry) get(handle string) *withSessionEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.entries[handle]
}

// withSessionOption removes the withSession callback from opts. A non-function value is an error.
func withSessionOption(opts map[string]any) (map[string]any, WithSessionFunc, error) {
	value, ok := opts["withSession"]
	if !ok || value == nil {
		return opts, nil, nil
	}
	args := maps.Clone(opts)
	delete(args, "withSession")
	switch callback := value.(type) {
	case WithSessionFunc:
		return args, callback, nil
	case func(ReplacedSessionContext) error:
		return args, callback, nil
	default:
		return nil, nil, fmt.Errorf("withSession must be a func(ReplacedSessionContext) error, got %T", value)
	}
}

// callReplacement makes a newSession, fork or switchSession call. A withSession callback cannot cross the process boundary, so the call names it by handle and the host runs it with a with_session request before the call returns. A callback error fails the call with that error, as Pi's awaited callback rejects the call.
func (c Context) callReplacement(method string, opts map[string]any) (CancelledResult, error) {
	args, callback, err := withSessionOption(opts)
	if err != nil {
		return CancelledResult{}, err
	}
	var entry *withSessionEntry
	if callback != nil {
		var handle string
		handle, entry = c.ext.withSessions.add(c.ext.name, callback)
		defer c.ext.withSessions.remove(handle)
		args = maps.Clone(args)
		if args == nil {
			args = map[string]any{}
		}
		args["withSession"] = handle
	}
	result, err := c.callHost(method, args)
	if err := callResultError(result, err); err != nil {
		if entry != nil {
			if failure := entry.failure(); failure != nil {
				return CancelledResult{}, failure
			}
		}
		return CancelledResult{}, err
	}
	return decodeCancelledResult(result), nil
}

// dispatchWithSession runs the callback a with_session request names with a context of the replacement Session. ctx is the request's context, so its host calls belong to the request.
func (e *Extension) dispatchWithSession(ctx Context, args json.RawMessage) error {
	var request struct {
		Handle string `json:"handle"`
		Ready  *struct {
			Cwd   string `json:"cwd"`
			Mode  string `json:"mode"`
			State *struct {
				HasUI *bool          `json:"hasUI"`
				Model map[string]any `json:"model"`
			} `json:"state"`
		} `json:"ready"`
	}
	if err := json.Unmarshal(args, &request); err != nil {
		return fmt.Errorf("decode with_session request: %w", err)
	}
	entry := e.withSessions.get(request.Handle)
	if entry == nil {
		return fmt.Errorf("unknown withSession callback %s", request.Handle)
	}
	state := &replacementState{}
	if ready := request.Ready; ready != nil {
		state.cwd, state.mode = ready.Cwd, ready.Mode
		if ready.State != nil {
			if ready.State.HasUI != nil {
				state.hasUI = *ready.State.HasUI
			}
			state.model, state.modelProvider = modelIdentity(ready.State.Model)
		}
	}
	ctx.replacement = state
	err := entry.callback(ReplacedSessionContext{Context: ctx})
	if err != nil {
		entry.fail(err)
	}
	return err
}

// replacementModel returns the replacement Session's current model id and provider. This process replicates only the requesting Session's model, so the replacement's comes from the host, or from the ready payload when the host cannot answer.
func (c Context) replacementModel() (id, provider string) {
	info, err := c.GetModelInfo()
	if err != nil {
		return c.replacement.model, c.replacement.modelProvider
	}
	if info == nil {
		return "", ""
	}
	return info.ID, info.Provider
}

// modelIdentity returns the model id (or name) and provider id of a state snapshot's model.
func modelIdentity(model map[string]any) (id, provider string) {
	if model == nil {
		return "", ""
	}
	if value, ok := model["id"].(string); ok && value != "" {
		id = value
	} else if value, ok := model["name"].(string); ok {
		id = value
	}
	switch value := model["provider"].(type) {
	case map[string]any:
		provider, _ = value["id"].(string)
	case string:
		provider = value
	}
	return id, provider
}
