// SPDX-FileCopyrightText: Copyright Hewlett Packard Enterprise Development LP
// SPDX-License-Identifier: MIT

package sdk

import "fmt"

// ToolConstrainedSampling is Pi's tool-level false-or-configuration union
// (ToolDefinition.constrainedSampling). A [ConstrainedSampling] value or
// pointer requests a configuration; [DisabledConstrainedSampling] sends an
// explicit false. Nil omits the field.
type ToolConstrainedSampling interface{ toolConstrainedSampling() }

func (ConstrainedSampling) toolConstrainedSampling() {}

// DisabledConstrainedSampling sends Pi's explicit false rather than omitting
// the sampling field. Pi's provider path treats false like omission.
type DisabledConstrainedSampling struct{}

func (DisabledConstrainedSampling) toolConstrainedSampling() {}

// MarshalJSON encodes the explicit false value.
func (DisabledConstrainedSampling) MarshalJSON() ([]byte, error) { return []byte("false"), nil }

// constrainedSamplingWire drops a nil union or nil configuration pointer so the registration omits the field.
func constrainedSamplingWire(sampling ToolConstrainedSampling) any {
	if config, ok := sampling.(*ConstrainedSampling); sampling == nil || ok && config == nil {
		return nil
	}
	return sampling
}

// ToolDefinition mirrors upstream ToolDefinition, the argument of
// pi.registerTool. Register it with [Extension.RegisterTool].
type ToolDefinition struct {
	// Name is the tool name the LLM calls.
	Name string
	// Label is the human-readable name shown in the UI.
	Label string
	// Description is the tool description sent to the LLM.
	Description string
	// PromptSnippet is the one-line entry for the default system prompt's
	// Available tools section. Empty leaves the tool out of that section.
	PromptSnippet string
	// PromptGuidelines are bullets added to the system prompt's Guidelines
	// section while the tool is active. Each must name the tool it refers to.
	PromptGuidelines []string
	// Parameters is the JSON Schema of the tool's arguments.
	Parameters Schema
	// ConstrainedSampling is a [ConstrainedSampling] configuration (value or
	// pointer) or [DisabledConstrainedSampling] for explicit false. Nil omits it.
	ConstrainedSampling ToolConstrainedSampling
	// RenderShell is upstream renderShell: [ToolRenderShellSelf] when the
	// renderers draw their own framing, else the default tool card.
	RenderShell ToolRenderShell
	// PrepareArguments transforms raw arguments before schema validation and
	// execution.
	PrepareArguments ToolPrepareArgumentsFunc
	// ExecutionMode is upstream executionMode: "sequential" or "parallel";
	// empty uses the agent default.
	ExecutionMode string
	// Execute runs the tool. The request's cancellation is ctx.Done and
	// partial results stream through ctx.OnUpdate.
	Execute ToolFunc
	// OutputSchema is the JSON Schema of StructuredContent in successful results. A tool that declares it should always set StructuredContent.
	// upstream: types.ts:585 (outputSchema)
	OutputSchema Schema
	// Exposure is how the model reaches the tool. Empty is [ToolExposureDirect].
	// upstream: types.ts:590 (exposure)
	Exposure ToolExposure
	// Namespace groups the tool with related tools, for example its MCP server.
	// upstream: types.ts:593 (namespace)
	Namespace *ToolNamespace
	// Annotations are hints about what the tool does.
	// upstream: types.ts:596 (annotations)
	Annotations *ToolAnnotations
	// DefaultActive is whether registering the tool activates it. Nil is the exposure's default: true for direct and model-only tools, false for the others. A tool with DefaultActive false is activated by naming it in `--tools` or the `defaultTools` setting, or with SetActiveTools.
	// upstream: types.ts:600 (defaultActive)
	DefaultActive *bool
	// PrepareLoadout adjusts how the loadout is presented to the model while this tool is active. The host calls it whenever the active tools change.
	// upstream: types.ts:607 (prepareLoadout)
	PrepareLoadout ToolPrepareLoadoutFunc
	// RenderCall renders the tool call; nil uses the host's default.
	RenderCall ToolRenderCallFunc
	// RenderResult renders the tool result; nil uses the host's default.
	RenderResult ToolRenderResultFunc
}

// RegisterTool registers a tool from its full definition, as pi.registerTool
// does. Registering a name again replaces the earlier definition in place. A running Session is refreshed before this method returns; invalid schemas and host failures panic.
func (e *Extension) RegisterTool(def ToolDefinition) {
	decl := toolDef{
		Name:             def.Name,
		Label:            def.Label,
		Description:      def.Description,
		Parameters:       def.Parameters,
		PromptGuidelines: def.PromptGuidelines,
		PromptSnippet:    def.PromptSnippet,
		ExecutionMode:    def.ExecutionMode,

		ConstrainedSampling: constrainedSamplingWire(def.ConstrainedSampling),

		OutputSchema:    def.OutputSchema,
		Exposure:        def.Exposure,
		Namespace:       def.Namespace,
		Annotations:     def.Annotations,
		DefaultActive:   def.DefaultActive,
		PreparesLoadout: def.PrepareLoadout != nil,
		prepareLoadout:  def.PrepareLoadout,
	}
	e.registerTool(decl, def.Execute, def.PrepareArguments, ToolRenderers{Shell: def.RenderShell, Call: def.RenderCall, Result: def.RenderResult})
}

func (e *Extension) registerTool(decl toolDef, handler ToolFunc, prepare ToolPrepareArgumentsFunc, renderers ToolRenderers) {
	e.validateToolSchema(decl.Name, decl.Parameters)
	e.toolMu.Lock()
	defer e.toolMu.Unlock()
	if renderers.Shell == ToolRenderShellSelf {
		decl.RenderShell = string(ToolRenderShellSelf)
	}
	decl.RendersCall, decl.RendersResult = renderers.Call != nil, renderers.Result != nil
	decl.PreparesArguments = prepare != nil
	replaced := false
	for i := range e.tools {
		if e.tools[i].Name == decl.Name {
			e.tools[i] = decl
			replaced = true
			break
		}
	}
	if !replaced {
		e.tools = append(e.tools, decl)
	}
	e.toolFuncs[decl.Name] = handler
	e.toolPrepareFuncs[decl.Name] = prepare
	if decl.prepareLoadout != nil {
		e.toolLoadoutFuncs[decl.Name] = decl.prepareLoadout
	} else {
		delete(e.toolLoadoutFuncs, decl.Name)
	}
	e.toolRenderMu.Lock()
	if e.toolRenderers == nil {
		e.toolRenderers = make(map[string]ToolRenderers)
	}
	e.toolRenderers[decl.Name] = renderers
	e.toolRenderMu.Unlock()
	e.publishTool(decl)
}

func (e *Extension) publishTool(decl toolDef) {
	if e.toolConn == nil {
		return
	}
	result, err := e.toolConn.call("registerTool", decl)
	if err != nil {
		panic(fmt.Errorf("registerTool: %w", err))
	}
	if result != nil && result.Error != nil {
		panic(fmt.Errorf("registerTool: %s", result.Error.Message))
	}
}
