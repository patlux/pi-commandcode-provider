package sdk

import (
	"fmt"
	"strconv"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// ToolRendererResolver chooses how calls to a tool are drawn, including tools that are not registered, as upstream
// ToolRendererResolver does. next returns the renderers the remaining resolvers, then the registered tool, would use,
// or nil. Return next() to keep them, nil for none, or renderers of this extension.
//
// pig divergence (D89): next() returns a marker for renderers the host draws. Returning it keeps them; its Call and
// Result are nil, so a resolver cannot wrap them. A marker given a Call or Result is the resolver's own renderers.
type ToolRendererResolver func(toolName string, next func() *ToolRenderers) *ToolRenderers

// ToolRenderer registers a tool renderer resolver (Pi's pi.registerToolRenderer). Resolvers run in extension load
// order, and an extension's resolvers in registration order.
//
// A registration while the extension registers with the host waits until the host is ready, and a later registration
// reports the new count to the host, in registration order.
func (e *Extension) ToolRenderer(resolver ToolRendererResolver) {
	e.toolMu.Lock()
	defer e.toolMu.Unlock()
	e.toolRenderMu.Lock()
	e.toolRendererResolvers = append(e.toolRendererResolvers, resolver)
	count := len(e.toolRendererResolvers)
	e.toolRenderMu.Unlock()
	if e.toolConn != nil {
		_ = e.toolConn.notify("tool_renderers", map[string]int{"count": count})
	}
}

func (e *Extension) toolRendererCount() int {
	e.toolRenderMu.Lock()
	defer e.toolRenderMu.Unlock()
	return len(e.toolRendererResolvers)
}

type toolRenderersDecl struct {
	RenderShell   string `json:"render_shell,omitempty"`
	RendersCall   bool   `json:"renders_call,omitempty"`
	RendersResult bool   `json:"renders_result,omitempty"`
}

type resolvedToolRenderers struct {
	Use string `json:"use"`
	toolRenderersDecl
	Renderers string `json:"renderers,omitempty"`
}

// resolveToolRenderers answers a resolve_tool_renderers request: the extension's resolvers run in registration order
// with the host's next() renderers last.
func (e *Extension) resolveToolRenderers(raw json.RawMessage) (result resolvedToolRenderers, err error) {
	var request struct {
		Tool string             `json:"tool"`
		Next *toolRenderersDecl `json:"next"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return resolvedToolRenderers{}, err
	}
	e.toolRenderMu.Lock()
	resolvers := append([]ToolRendererResolver(nil), e.toolRendererResolvers...)
	e.toolRenderMu.Unlock()
	var marker *ToolRenderers
	if request.Next != nil {
		marker = &ToolRenderers{Shell: ToolRenderShell(request.Next.RenderShell)}
	}
	var resolve func(index int) *ToolRenderers
	resolve = func(index int) *ToolRenderers {
		if index < len(resolvers) {
			return resolvers[index](request.Tool, func() *ToolRenderers { return resolve(index + 1) })
		}
		return marker
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("tool renderer resolver panicked: %v", recovered)
		}
	}()
	got := resolve(0)
	if got == nil {
		return resolvedToolRenderers{Use: "none"}, nil
	}
	if got == marker && got.Call == nil && got.Result == nil {
		return resolvedToolRenderers{Use: "next"}, nil
	}
	e.toolRenderMu.Lock()
	if e.resolvedToolRenderers == nil {
		e.resolvedToolRenderers = map[string]ToolRenderers{}
	}
	id := "r" + strconv.Itoa(len(e.resolvedToolRenderers)+1)
	e.resolvedToolRenderers[id] = *got
	e.toolRenderMu.Unlock()
	shell := ""
	if got.Shell == ToolRenderShellSelf {
		shell = string(ToolRenderShellSelf)
	}
	return resolvedToolRenderers{
		Use:               "own",
		toolRenderersDecl: toolRenderersDecl{RenderShell: shell, RendersCall: got.Call != nil, RendersResult: got.Result != nil},
		Renderers:         id,
	}, nil
}
