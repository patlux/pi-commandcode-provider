package sdk

import (
	"errors"
	"fmt"
	"os"
	"slices"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// Ports packages/coding-agent/src/core/virtual-models.ts (the routing types).
// Ports packages/coding-agent/src/core/extensions/loader.ts (registerVirtualModel, unregisterVirtualModel).

// ModelRouteReason says why a request is being routed: "user" (first request after a message the user wrote), "continuation" (any other request in the agent loop), "retry" (automatic retry after a failed request) or "direct" (a request outside the agent loop, such as a compaction summary).
//
// upstream: virtual-models.ts:53 (ModelRouteReason)
type ModelRouteReason string

// The reasons of upstream's ModelRouteReason union.
const (
	ModelRouteReasonUser         ModelRouteReason = "user"
	ModelRouteReasonContinuation ModelRouteReason = "continuation"
	ModelRouteReasonRetry        ModelRouteReason = "retry"
	ModelRouteReasonDirect       ModelRouteReason = "direct"
)

// ModelRoutePrevious is the physical model and thinking level of the latest successful response in a request's messages.
type ModelRoutePrevious struct {
	Model         map[string]any `json:"model"`
	ThinkingLevel string         `json:"thinkingLevel,omitempty"`
}

// ModelRouteFailed is the failed request of a "retry". Message is its AssistantMessage, with the stop reason and error message.
type ModelRouteFailed struct {
	Model         map[string]any `json:"model"`
	ThinkingLevel string         `json:"thinkingLevel,omitempty"`
	Message       map[string]any `json:"message"`
}

// ModelRouteRequest is what a router sees for one request. The request's cancellation is the router's Context.
//
// upstream: virtual-models.ts:55-72 (ModelRouteRequest)
type ModelRouteRequest struct {
	// Model is the selected virtual model, as an extension-facing Model object.
	Model map[string]any `json:"model"`
	// ThinkingLevel is the selected thinking level. Its meaning is up to the router.
	ThinkingLevel string              `json:"thinkingLevel"`
	Reason        ModelRouteReason    `json:"reason"`
	Previous      *ModelRoutePrevious `json:"previous,omitempty"`
	Failed        *ModelRouteFailed   `json:"failed,omitempty"`
	// State is the router state last returned on this session branch: absent (nil) before the first state and for "direct" requests.
	State json.RawMessage `json:"state,omitempty"`
	// Messages is the conversation for this request, including system messages.
	Messages []map[string]any `json:"messages"`
}

// ModelRoute is the physical model and thinking level for one request.
//
// upstream: virtual-models.ts:75-85 (ModelRoute)
type ModelRoute struct {
	// Model is the physical Model object, for example from [ModelRegistry.Find]. It must have credentials.
	Model         map[string]any
	ThinkingLevel string
	// State is the new router state, stored on the session branch unless it is the request's own state. Nil, or the request's State when it has none, keeps the current state. It must be JSON.
	State any
}

// ModelRouteFunc picks the physical model and thinking level for one request. ctx carries the request's cancellation. An error fails the request.
type ModelRouteFunc func(ctx Context, request ModelRouteRequest) (ModelRoute, error)

// VirtualModel is a selectable catalog entry that routes each request to a physical model.
//
// upstream: types.ts:1864-1867 (ExtensionVirtualModel), virtual-models.ts:87-101 (VirtualModelDefinition)
type VirtualModel struct {
	// Provider is the provider the virtual model is listed under. It may be a provider with physical models.
	Provider string
	// ID must not be the id of a physical model of Provider.
	ID   string
	Name string
	// ThinkingLevels are the thinking levels offered for selection. The host defaults them to ["off"].
	ThinkingLevels []string
	// ContextWindow and MaxTokens are the limits shown before the first response. Unset limits are unknown (0).
	ContextWindow int
	MaxTokens     int
	// Input are the input types accepted for selection. The host defaults them to text and images.
	Input []string
	Route ModelRouteFunc
}

// virtualModelKey names a virtual model.
type virtualModelKey struct{ provider, id string }

// RegisterVirtualModel registers a virtual model: a selectable catalog entry that routes each request to a physical model. Registering the same provider and id again replaces the virtual model. A model without a Route is an error.
//
// Before [Extension.Run] the registration is queued for the host to apply when the extension loads. After that it applies at once and the error is the host's refusal.
//
// upstream: loader.ts:480-490 (registerVirtualModel)
func (e *Extension) RegisterVirtualModel(model VirtualModel) error {
	return e.registerVirtualModel(nil, model)
}

// UnregisterVirtualModel removes a virtual model registered with [Extension.RegisterVirtualModel]. A failure of the host call is reported where the host shows extension output.
//
// upstream: loader.ts:492-495 (unregisterVirtualModel)
func (e *Extension) UnregisterVirtualModel(provider, id string) {
	e.unregisterVirtualModel(nil, provider, id)
}

// RegisterVirtualModel registers a virtual model; see [Extension.RegisterVirtualModel].
func (c Context) RegisterVirtualModel(model VirtualModel) error {
	return c.ext.registerVirtualModel(&c, model)
}

// UnregisterVirtualModel removes a virtual model.
func (c Context) UnregisterVirtualModel(provider, id string) {
	c.ext.unregisterVirtualModel(&c, provider, id)
}

func (e *Extension) registerVirtualModel(c *Context, model VirtualModel) error {
	if model.Route == nil {
		return fmt.Errorf("virtual model %s/%s must define a route", model.Provider, model.ID)
	}
	decl := virtualModelDecl{
		Provider: model.Provider, ID: model.ID, Name: model.Name, ThinkingLevels: model.ThinkingLevels,
		ContextWindow: model.ContextWindow, MaxTokens: model.MaxTokens, Input: model.Input,
	}
	key := virtualModelKey{model.Provider, model.ID}
	e.toolMu.Lock()
	conn := e.toolConn
	previous, replaced := e.virtualModelRoutes[key]
	// The route is in place before the host learns of the model: it may route at once.
	e.virtualModelRoutes[key] = model.Route
	if conn == nil {
		defer e.toolMu.Unlock()
		for i := range e.virtualModelDecls {
			if e.virtualModelDecls[i].Provider == decl.Provider && e.virtualModelDecls[i].ID == decl.ID {
				e.virtualModelDecls[i] = decl
				return nil
			}
		}
		e.virtualModelDecls = append(e.virtualModelDecls, decl)
		return nil
	}
	e.toolMu.Unlock()
	result, err := hostCallFor(c, conn, "registerVirtualModel", decl)
	if err := callResultError(result, err); err != nil {
		e.toolMu.Lock()
		if replaced {
			e.virtualModelRoutes[key] = previous
		} else {
			delete(e.virtualModelRoutes, key)
		}
		e.toolMu.Unlock()
		return err
	}
	return nil
}

func (e *Extension) unregisterVirtualModel(c *Context, provider, id string) {
	key := virtualModelKey{provider, id}
	e.toolMu.Lock()
	conn := e.toolConn
	if conn == nil {
		defer e.toolMu.Unlock()
		e.virtualModelDecls = slices.DeleteFunc(e.virtualModelDecls, func(decl virtualModelDecl) bool { return decl.Provider == provider && decl.ID == id })
		// Pi filters the runtime-wide queue (loader.ts:228-232), so the host removes another extension's queued model too.
		e.virtualModelUnregistrations = append(e.virtualModelUnregistrations, virtualModelRef{provider, id})
		delete(e.virtualModelRoutes, key)
		return
	}
	e.toolMu.Unlock()
	args := struct {
		Provider string `json:"provider"`
		ID       string `json:"id"`
	}{provider, id}
	result, err := hostCallFor(c, conn, "unregisterVirtualModel", args)
	if err := callResultError(result, err); err != nil {
		fmt.Fprintf(os.Stderr, "pig: host call unregisterVirtualModel failed: %v\n", err)
		return
	}
	e.toolMu.Lock()
	delete(e.virtualModelRoutes, key)
	e.toolMu.Unlock()
}

// dispatchVirtualModelRoute answers the host's virtual_model_route request with the route of the named virtual model.
//
// upstream: loader.ts:485-487, virtual-models.ts:100
func (e *Extension) dispatchVirtualModelRoute(ctx Context, args json.RawMessage) (any, error) {
	var payload struct {
		Provider string            `json:"provider"`
		ID       string            `json:"id"`
		Request  ModelRouteRequest `json:"request"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return nil, fmt.Errorf("decode virtual model route request: %w", err)
	}
	e.toolMu.RLock()
	route := e.virtualModelRoutes[virtualModelKey{payload.Provider, payload.ID}]
	e.toolMu.RUnlock()
	if route == nil {
		return nil, fmt.Errorf("unknown virtual model %s/%s", payload.Provider, payload.ID)
	}
	routed, err := route(ctx, payload.Request)
	if err != nil {
		return nil, err
	}
	if routed.Model == nil {
		return nil, errors.New("virtual model " + payload.Provider + "/" + payload.ID + " routed to no model")
	}
	// Returning request.State keeps the state (virtual-models.ts:77-83). Before the first state it is an empty RawMessage, which is upstream's undefined and must not reach the host as a null state.
	if raw, ok := routed.State.(json.RawMessage); ok && len(raw) == 0 {
		routed.State = nil
	}
	return struct {
		Model         map[string]any `json:"model"`
		ThinkingLevel string         `json:"thinkingLevel"`
		State         any            `json:"state,omitempty"`
	}{routed.Model, routed.ThinkingLevel, routed.State}, nil
}
