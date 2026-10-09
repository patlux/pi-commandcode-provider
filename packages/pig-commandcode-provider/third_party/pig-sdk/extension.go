package sdk

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"maps"
	"net"
	"os"
	"runtime/debug"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// Schema is a JSON Schema object for tool parameter definitions.
type Schema = map[string]any

// ToolPrepareArgumentsFunc transforms compatibility inputs before schema validation and execution.
type ToolPrepareArgumentsFunc func(params map[string]any) (map[string]any, error)

// ToolFunc is the handler for a tool execution.
// params is the decoded JSON params from the LLM.
// Return any serializable result, or an error.
type ToolFunc func(ctx Context, params map[string]any) (any, error)

// CommandFunc is the handler for a slash command.
type CommandFunc func(ctx Context, args string) error

// EventFunc is the handler for a lifecycle event.
// Return a result value to pass data back to the host (e.g.,
// BeforeAgentStartEventResult with SystemPrompt override).
// Most handlers return (nil, nil) to acknowledge without data.
type EventFunc func(ctx Context, data map[string]any) (any, error)

type ProjectTrustDecision string

const (
	ProjectTrustYes       ProjectTrustDecision = "yes"
	ProjectTrustNo        ProjectTrustDecision = "no"
	ProjectTrustUndecided ProjectTrustDecision = "undecided"
)

type ProjectTrustResult struct {
	Trusted  ProjectTrustDecision `json:"trusted"`
	Remember bool                 `json:"remember,omitempty"`
}

type ProjectTrustFunc func(ctx Context, data map[string]any) (ProjectTrustResult, error)

// ShortcutFunc is the handler for a keyboard shortcut.
type ShortcutFunc func(ctx Context) error

// FlagType is the supported CLI flag type.
type FlagType string

const (
	FlagBoolean FlagType = "boolean"
	FlagString  FlagType = "string"
)

// FlagOptions describes an extension CLI flag.
type FlagOptions struct {
	Description string
	Type        FlagType
	Default     any
}

// ProviderConfig registers or overrides a model provider.
type ProviderConfig map[string]any

// MessageRenderOptions is the renderer request options.
type MessageRenderOptions struct {
	Expanded bool `json:"expanded"`
	// OutputPad is the horizontal padding configured by the outputPad setting.
	OutputPad int `json:"outputPad"`
}

// RendererFunc renders a custom message into terminal lines for the host.
type RendererFunc func(ctx Context, message map[string]any, options MessageRenderOptions, width int) ([]string, error)

// EntryRenderOptions is the entry-renderer request options.
type EntryRenderOptions struct {
	Expanded bool `json:"expanded"`
}

// EntryRendererFunc renders a custom session entry into terminal lines for the host.
type EntryRendererFunc func(ctx Context, entry map[string]any, options EntryRenderOptions, width int) ([]string, error)

// MarkdownTransformContext mirrors Pi's MarkdownTransformContext: the
// transcript message being rendered ("user", "assistant" or
// "assistant-thinking"), whether it is still streaming, and the width it is
// rendered at.
type MarkdownTransformContext struct {
	MessageType    string `json:"messageType"`
	IsStreaming    bool   `json:"isStreaming"`
	AvailableWidth int    `json:"availableWidth"`
}

// MarkdownTransformerFunc rewrites Markdown for display only, as Pi's
// MarkdownTransformer does. A transformer that panics keeps its input.
type MarkdownTransformerFunc func(markdown string, context MarkdownTransformContext) string

// Factory constructs an extension instance for generated standalone or packed
// runners. Factory-style packages should expose a function such as:
//
//	func Extension() *sdk.Extension
//
// Generated runners call that factory, then run the returned extension over a
// host-provided subprocess socket.
type Factory func() *Extension

// Extension is the builder for a subprocess extension. Create with [New],
// register tools/commands/events, then call [Extension.Run].
type Extension struct {
	name     string
	tools    []toolDef
	commands []cmdDef
	handlers []handlerDef

	eventMu     sync.Mutex
	eventNextID int

	// run is the replicated signal of the run in progress (Context.Signal).
	run runSignal

	providerStreams         map[string]ProviderStreamSimpleFunc
	providerOperations      map[string]providerOperations
	toolMu                  sync.RWMutex
	toolConn                *conn
	toolFuncs               map[string]ToolFunc
	toolPrepareFuncs        map[string]ToolPrepareArgumentsFunc
	toolStarts              toolStartOrder
	commandFuncs            map[string]CommandFunc
	eventFuncs              map[int]EventFunc
	shortcutFuncs           map[string]ShortcutFunc
	rendererFuncs           map[string]RendererFunc
	entryRendererFuncs      map[string]EntryRendererFunc
	flagDefaults            map[string]any
	shortcuts               []shortcutDef
	flags                   []flagDef
	providers               []providerDef
	providerMu              sync.RWMutex
	autocomplete            autocompleteRegistry
	nativeProviders         map[string]*Provider
	providerObjectCallbacks map[string]func(string, json.RawMessage) (any, error)
	providerUpdates         map[string]func() error
	providerObjectCache     map[string]*Provider
	renderers               []rendererDef
	entryRenderers          []rendererDef
	markdownTransform       MarkdownTransformerFunc

	// toolRenderMu guards toolRenderers and toolRenderCards: render requests
	// run on their own goroutines.
	toolRenderMu    sync.Mutex
	toolRenderers   map[string]ToolRenderers
	toolRenderCards map[string]*toolRenderCard
	// toolRendererResolvers are the pi.registerToolRenderer resolvers in registration order; resolvedToolRenderers
	// holds the renderers they returned, by the id the host draws them with. Both are guarded by toolRenderMu.
	toolRendererResolvers []ToolRendererResolver
	resolvedToolRenderers map[string]ToolRenderers

	// terminalInputMu guards terminalInputFuncs, which the host consults
	// synchronously while it holds the user's keystroke.
	terminalInputMu     sync.RWMutex
	terminalInputFuncs  []terminalInputSub
	terminalInputNextID uint64

	// widthChangeMu guards widthChangeFuncs, notified after e.width is updated
	// so a handler that reads Context.Width sees the new value.
	widthChangeMu     sync.RWMutex
	widthChangeFuncs  []widthChangeSub
	widthChangeNextID uint64

	// widthMu guards the width deliveries waiting for their worker goroutine. A width handler can block on a host call, so it never runs on the message loop or the read loop (see notifyWidthChange).
	widthMu         sync.Mutex
	widthDeliveries []widthDelivery
	widthRunning    bool
	widthStopped    bool

	// surfaceMu guards surfaces, the footer and header renderers keyed by the
	// host method that installs them.
	surfaceMu sync.Mutex
	surfaces  map[string]*surfaceRenderer

	// oauthProviders holds the OAuth closures for providers registered with an
	// "oauth" capability, keyed by provider name for oauth_* dispatch.
	oauthProviders map[string]*OAuthProvider

	// conn is set during Run().
	conn *conn

	// session is the local session mirror, kept in sync by incremental
	// appends from the host. GetBranch() and GetEntries() read from it
	// instead of fetching the entire log over IPC.
	session sessionMirror

	// session info from host (set after ready message).
	mu            sync.RWMutex
	sessionName   string
	cwd           string
	mode          string
	hasUI         bool
	width         int
	height        int
	model         string
	modelProvider string
	sessionFile   string
	// uiTheme is the host's theme palette from the state snapshot and
	// theme_change notifies (upstream ctx.ui.theme).
	uiTheme UITheme

	requestsMu sync.Mutex
	requests   map[string]context.CancelFunc
	requestWG  sync.WaitGroup
	runCtx     context.Context
	runCancel  context.CancelFunc

	// withSessions holds the withSession callbacks of replacement calls in flight.
	withSessions withSessionRegistry

	modelStreamSeq atomic.Uint64
	modelStreamsMu sync.RWMutex
	modelStreams   map[string]*ModelEventStream

	overlaySeq atomic.Uint64
	overlaysMu sync.RWMutex
	overlays   map[string]*remoteOverlay

	// notifyMu guards notifyHandled and notifyChanged, which let a host-call
	// goroutine wait for notifications that preceded the call result.
	notifyMu      sync.Mutex
	notifyHandled uint64
	notifyChanged chan struct{}

	// eventBus holds the pi.events listeners.
	eventBus busRegistry

	// commandCompletions are the commands' getArgumentCompletions.
	commandCompletions map[string]ArgumentCompletionsFunc

	// The registrations of the upstream 0.99.1 API are guarded by toolMu like the tools: the queues hold what a factory registered before Run, and the maps hold the callbacks the host's requests reach.
	mcpServerDecls    []mcpServerDecl
	virtualModelDecls []virtualModelDecl
	// virtualModelUnregistrations are the unregistrations made before Run, in call order.
	virtualModelUnregistrations []virtualModelRef
	virtualModelRoutes          map[virtualModelKey]ModelRouteFunc
	toolLoadoutFuncs            map[string]ToolPrepareLoadoutFunc

	// The host's replicated state of the upstream 0.99.1 API, as raw JSON so each read decodes a copy the caller owns. It is guarded by mu.
	settingsRaw   json.RawMessage
	mcpServersRaw json.RawMessage
	// mcpServersAt is the position of mcpServersRaw in the host's frame order: 2k for the state of the k-th notify frame, 2n+1 for the reply of a registration call routed after n notify frames. A list from an earlier position never replaces it.
	mcpServersAt uint64

	// executeUpdates holds the OnUpdate callbacks of the executeTool calls in flight, by execute id.
	executeSeq     atomic.Uint64
	executeMu      sync.Mutex
	executeUpdates map[string]func(AgentToolResult)
}

const (
	remoteComponentStopTimeout  = time.Second
	extensionHandlerStopTimeout = 2 * time.Second
	remoteRenderInterval        = 16 * time.Millisecond
)

type remoteOverlay struct {
	mu         sync.Mutex
	component  RemoteComponent
	lastLines  []string
	seq        uint64
	closed     bool
	lastRender time.Time
	active     atomic.Bool
	invalidate chan struct{}
	input      chan string
	stopCh     chan struct{}
	stopped    chan struct{}
	stopOnce   sync.Once
}

func newRemoteOverlay(component RemoteComponent) *remoteOverlay {
	return &remoteOverlay{component: component}
}

func (o *remoteOverlay) start(conn *conn, key string, width func() int) (err error) {
	o.invalidate = make(chan struct{}, 1)
	o.input = make(chan string, 64)
	o.stopCh = make(chan struct{})
	o.active.Store(true)
	if invalidator, ok := o.component.(RemoteComponentInvalidator); ok {
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					err = fmt.Errorf("attach focused invalidation: %v", recovered)
				}
			}()
			invalidator.SetInvalidate(o.requestRender)
		}()
		if err != nil {
			o.active.Store(false)
			return err
		}
	}
	o.stopped = make(chan struct{})
	go func() {
		defer close(o.stopped)
		for o.active.Load() {
			select {
			case data := <-o.input:
				if !o.active.Load() {
					return
				}
				o.handleInput(conn, key, data, width())
			case <-o.invalidate:
				if !o.active.Load() {
					return
				}
				if !o.waitRenderSlot() {
					return
				}
				if err := o.render(conn, key, width()); err != nil {
					o.closeWithError(conn, key, err)
				}
			case <-o.stopCh:
				return
			}
		}
	}()
	return nil
}

func (o *remoteOverlay) waitRenderSlot() bool {
	o.mu.Lock()
	delay := time.Until(o.lastRender.Add(remoteRenderInterval))
	o.mu.Unlock()
	if delay <= 0 {
		return true
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-o.stopCh:
		return false
	}
}

func (o *remoteOverlay) requestRender() {
	if !o.active.Load() {
		return
	}
	select {
	case o.invalidate <- struct{}{}:
	default:
	}
}

func (o *remoteOverlay) enqueueInput(conn *conn, key, data string) {
	if !o.active.Load() {
		return
	}
	select {
	case o.input <- data:
	default:
		o.closeWithError(conn, key, errors.New("focused input queue is full"))
	}
}

func (o *remoteOverlay) stop() bool {
	o.active.Store(false)
	if invalidator, ok := o.component.(RemoteComponentInvalidator); ok {
		func() {
			defer func() { _ = recover() }()
			invalidator.SetInvalidate(nil)
		}()
	}
	if o.stopped == nil {
		return true
	}
	o.stopOnce.Do(func() { close(o.stopCh) })
	select {
	case <-o.stopped:
		return true
	case <-time.After(remoteComponentStopTimeout):
		return false
	}
}

func (o *remoteOverlay) closeWithError(conn *conn, key string, err error) {
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	o.closed = true
	o.active.Store(false)
	o.mu.Unlock()
	_ = conn.notify("ui.custom.close", map[string]any{"key": key, "error": err.Error()})
}

func (o *remoteOverlay) handleInput(conn *conn, key, data string, width int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	defer func() {
		if recovered := recover(); recovered != nil && !o.closed {
			o.closed = true
			_ = conn.notify("ui.custom.close", map[string]any{"key": key, "error": fmt.Sprintf("focused input panicked: %v", recovered)})
		}
	}()
	if o.closed {
		return
	}
	result, err := o.component.HandleInput(data)
	if err != nil {
		o.closed = true
		_ = conn.notify("ui.custom.close", map[string]any{"key": key, "error": err.Error()})
		return
	}
	if result.Done {
		o.closed = true
		o.active.Store(false)
		if err := conn.notify("ui.custom.close", map[string]any{"key": key, "result": result.Value}); err != nil {
			_ = conn.notify("ui.custom.close", map[string]any{"key": key, "error": "encode focused result: " + err.Error()})
		}
		return
	}
	_ = o.renderLocked(conn, key, width)
}

func (o *remoteOverlay) render(conn *conn, key string, width int) (err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("focused render panicked: %v", recovered)
		}
	}()
	return o.renderLocked(conn, key, width)
}

func (o *remoteOverlay) renderLocked(conn *conn, key string, width int) error {
	if o.closed {
		return nil
	}
	lines := o.component.Render(width)
	o.lastRender = time.Now()
	if slices.Equal(lines, o.lastLines) {
		return nil
	}
	o.lastLines = append(o.lastLines[:0], lines...)
	o.seq++
	return conn.notify("ui.custom.render", map[string]any{"key": key, "lines": lines, "width": width, "seq": o.seq})
}

// New creates a new extension with the given name.
// The name must match the identity of the selected Package, Piglet, or exact path.
func New(name string) *Extension {
	return &Extension{
		name:               name,
		toolFuncs:          make(map[string]ToolFunc),
		toolPrepareFuncs:   make(map[string]ToolPrepareArgumentsFunc),
		commandFuncs:       make(map[string]CommandFunc),
		commandCompletions: make(map[string]ArgumentCompletionsFunc),
		eventFuncs:         make(map[int]EventFunc),
		shortcutFuncs:      make(map[string]ShortcutFunc),
		rendererFuncs:      make(map[string]RendererFunc),
		entryRendererFuncs: make(map[string]EntryRendererFunc),
		flagDefaults:       make(map[string]any),
		requests:           make(map[string]context.CancelFunc),
		modelStreams:       make(map[string]*ModelEventStream),
		overlays:           make(map[string]*remoteOverlay),
		virtualModelRoutes: make(map[virtualModelKey]ModelRouteFunc),
		toolLoadoutFuncs:   make(map[string]ToolPrepareLoadoutFunc),
		executeUpdates:     make(map[string]func(AgentToolResult)),
	}
}

// Name returns the extension's registered name.
func (e *Extension) Name() string { return e.name }

// Tool registers a tool that the LLM can invoke. A nil schema panics before registration; an empty object is valid.
func (e *Extension) Tool(name, description string, schema Schema, handler ToolFunc) {
	e.registerTool(toolDef{Name: name, Description: description, Parameters: schema}, handler, nil, ToolRenderers{})
}

// validateToolSchema rejects invalid programmer input before a declaration can replace a valid tool.
// upstream: packages/coding-agent/src/core/extensions/loader.ts:registerTool
func (e *Extension) validateToolSchema(name string, schema Schema) {
	if schema == nil {
		panic(fmt.Errorf(`Tool "%s" registered by extension "%s" must define an object parameter schema.`, name, e.name))
	}
}

// ToolPromptSnippet sets the registered tool's optional system-prompt summary and refreshes a running Session.
func (e *Extension) ToolPromptSnippet(name, snippet string) {
	e.toolMu.Lock()
	defer e.toolMu.Unlock()
	for i := range e.tools {
		if e.tools[i].Name == name {
			e.tools[i].PromptSnippet = snippet
			e.publishTool(e.tools[i])
		}
	}
}

// ToolWithPrepareArguments registers a tool with a local pre-validation argument transform. A nil schema panics before registration.
func (e *Extension) ToolWithPrepareArguments(name, description string, schema Schema, prepare ToolPrepareArgumentsFunc, handler ToolFunc) {
	e.registerTool(toolDef{Name: name, Description: description, Parameters: schema}, handler, prepare, ToolRenderers{})
}

// ToolWithGuidelines registers a tool with system prompt guidelines. A nil schema panics before registration.
// Guidelines are bullets injected into the system prompt's Guidelines section
// when this tool is active. Each guideline must name the tool it refers to -
// write "Use my_tool when..." not "Use this tool when...".
// Mirrors upstream pi's promptGuidelines on ToolDefinition.
func (e *Extension) ToolWithGuidelines(name, description string, schema Schema, guidelines []string, handler ToolFunc) {
	e.registerTool(toolDef{Name: name, Description: description, Parameters: schema, PromptGuidelines: guidelines}, handler, nil, ToolRenderers{})
}

// ToolWithSource registers a tool with an explicit source identifier. A nil schema panics before registration.
// Source overrides the default extension-name attribution Piglet tool
// scoping reads, allowing extensions that wrap external tool sources (e.g.
// MCP servers) to provide per-tool provenance. GetAllTools reports it in the
// deprecated ToolInfo.Source; ToolInfo.SourceInfo is the extension's.
// pig additive (D23): ToolWithSource adds per-tool source attribution.
// Example: ext.ToolWithSource("list_models", desc, schema, "mcp:mctl-platform", guidelines, handler)
func (e *Extension) ToolWithSource(name, description string, schema Schema, source string, guidelines []string, handler ToolFunc) {
	e.registerTool(toolDef{Name: name, Description: description, Parameters: schema, PromptGuidelines: guidelines, Source: source}, handler, nil, ToolRenderers{})
}

// ConstrainedSampling is a provider-side constrained sampling request for a tool.
// Type is "json_schema" or "grammar". For json_schema, Strict is "prefer" or
// "require". For grammar, Variants maps a grammar format ("openai_lark",
// "openai_regex") to its definition. Mirrors upstream ConstrainedSamplingConfig.
type ConstrainedSampling struct {
	Type     string            `json:"type"`
	Strict   string            `json:"strict,omitempty"`
	Variants map[string]string `json:"variants,omitempty"`
}

// ToolWithConstrainedSampling registers a tool that requests provider-side constrained sampling. A nil schema panics before registration.
// The host forwards the request to the provider, including grammar and strict-mode settings for OpenAI-compatible providers.
// Pass DisabledConstrainedSampling{} to send Pi's explicit false.
func (e *Extension) ToolWithConstrainedSampling(name, description string, schema Schema, sampling ToolConstrainedSampling, handler ToolFunc) {
	e.registerTool(toolDef{Name: name, Description: description, Parameters: schema, ConstrainedSampling: constrainedSamplingWire(sampling)}, handler, nil, ToolRenderers{})
}

// Command registers a slash command (e.g. /hello).
func (e *Extension) Command(name, description string, handler CommandFunc) {
	e.validateCommand(name, handler != nil)
	e.commands = append(e.commands, cmdDef{
		Name:        name,
		Description: description,
	})
	e.commandFuncs[name] = handler
}

// Shortcut registers a keyboard shortcut handler (e.g. "ctrl+shift+s").
func (e *Extension) Shortcut(key, description string, handler ShortcutFunc) {
	e.shortcuts = append(e.shortcuts, shortcutDef{
		Key:         key,
		Description: description,
	})
	e.shortcutFuncs[key] = handler
}

// Flag registers a CLI flag declaration for the extension.
func (e *Extension) Flag(name string, options FlagOptions) {
	def := flagDef{
		Name:        name,
		Description: options.Description,
		Type:        string(options.Type),
	}
	if options.Default != nil {
		data, _ := json.Marshal(options.Default)
		def.Default = data
	}
	e.flags = append(e.flags, def)
	if e.flagDefaults[name] == nil {
		e.flagDefaults[name] = options.Default
	}
}

// RegisterProvider registers or overrides a model provider. When config carries
// an *OAuthProvider under the "oauth" key, its closures are stored for oauth_*
// dispatch and the wire config gets a serializable capability descriptor in
// their place. Before Run registers the extension the call is queued; after
// that it takes effect at once through the host, as Pi's pi.registerProvider
// does once the runner is bound (types.ts:1766-1803, runner.ts:517-523), and a
// registration the host refuses panics like Pi's throwing call.
func (e *Extension) RegisterProvider(name string, config ProviderConfig) {
	e.toolMu.Lock()
	conn := e.toolConn
	if conn != nil {
		e.toolMu.Unlock()
		if err := e.registerProviderNow(nil, conn, name, config); err != nil {
			panic(fmt.Errorf("registerProvider: %w", err))
		}
		return
	}
	defer e.toolMu.Unlock()
	e.providerMu.Lock()
	defer e.providerMu.Unlock()
	// The register payload carries a config JSON cannot encode as null.
	def, _ := e.takeProviderDef(name, config)
	e.providers = append(e.providers, def)
}

// takeProviderDef keeps the callbacks of a provider config in the extension and returns the declaration the host receives: the register payload's entry and the registerProvider call after the factory carry the same one. An invalid callback panics, and a config JSON cannot encode is an error with a nil Config; the caller restores the held callbacks in both cases when it needs them. The caller holds providerMu.
func (e *Extension) takeProviderDef(name string, config ProviderConfig) (providerDef, error) {
	config = maps.Clone(config)
	streaming := false
	if raw, exists := config["streamSimple"]; exists {
		handler, ok := raw.(ProviderStreamSimpleFunc)
		if !ok {
			panic("provider streamSimple has an invalid Go callback signature")
		}
		if e.providerStreams == nil {
			e.providerStreams = make(map[string]ProviderStreamSimpleFunc)
		}
		e.providerStreams[name] = handler
		delete(config, "streamSimple")
		streaming = true
	}
	// A re-registration replaces only the kinds it defines, as registerProvider merges defined values (model-runtime.ts registerProvider) and the host keeps the APIs it wired.
	ops, imageAPIs, classifierAPIs := takeProviderOperations(config)
	if len(imageAPIs)+len(classifierAPIs) > 0 {
		if e.providerOperations == nil {
			e.providerOperations = make(map[string]providerOperations)
		}
		kept := e.providerOperations[name]
		if len(imageAPIs) > 0 {
			kept.images = ops.images
		}
		if len(classifierAPIs) > 0 {
			kept.classifiers = ops.classifiers
		}
		e.providerOperations[name] = kept
	}
	if raw, ok := config["oauth"]; ok {
		if provider, ok := raw.(*OAuthProvider); ok && provider != nil {
			e.registerOAuthProvider(name, provider)
			cfg := make(ProviderConfig, len(config))
			maps.Copy(cfg, config)
			cfg["oauth"] = oauthConfigFor(name, provider)
			config = cfg
		}
	}
	data, err := json.Marshal(config)
	return providerDef{Name: name, Config: data, StreamSimple: streaming, ImageAPIs: imageAPIs, ClassifierAPIs: classifierAPIs}, err
}

// heldCallbacks are the callbacks an extension holds for one provider name.
type heldCallbacks struct {
	stream     ProviderStreamSimpleFunc
	operations providerOperations
	hasOps     bool
	oauth      *OAuthProvider
}

// heldProviderCallbacks returns what the extension holds for a provider. The caller holds providerMu.
func (e *Extension) heldProviderCallbacks(name string) heldCallbacks {
	kept := heldCallbacks{stream: e.providerStreams[name], oauth: e.oauthProviders[name]}
	kept.operations, kept.hasOps = e.providerOperations[name]
	return kept
}

// restoreHeldProviderCallbacks makes the extension hold exactly kept for a provider, deleting what kept lacks. The caller holds providerMu.
func (e *Extension) restoreHeldProviderCallbacks(name string, kept heldCallbacks) {
	if kept.stream != nil {
		e.providerStreams[name] = kept.stream
	} else {
		delete(e.providerStreams, name)
	}
	if kept.hasOps {
		e.providerOperations[name] = kept.operations
	} else {
		delete(e.providerOperations, name)
	}
	if kept.oauth != nil {
		e.oauthProviders[name] = kept.oauth
	} else {
		delete(e.oauthProviders, name)
	}
}

// UnregisterProvider removes a provider registration. Before Run registers the
// extension it drops the queued registration; after that the host removes the
// provider at once, as Pi's pi.unregisterProvider does (types.ts:1805-1819), and
// a removal the host refuses panics.
func (e *Extension) UnregisterProvider(name string) {
	e.toolMu.Lock()
	conn := e.toolConn
	e.toolMu.Unlock()
	if conn != nil {
		if err := e.unregisterProviderNow(nil, conn, name); err != nil {
			panic(fmt.Errorf("unregisterProvider: %w", err))
		}
		return
	}
	e.dropQueuedProvider(name)
}

// dropQueuedProvider removes a queued registration and the callbacks the extension holds for it.
func (e *Extension) dropQueuedProvider(name string) {
	e.providerMu.Lock()
	defer e.providerMu.Unlock()
	delete(e.providerStreams, name)
	delete(e.providerOperations, name)
	filtered := e.providers[:0]
	for _, provider := range e.providers {
		if provider.Name != name {
			filtered = append(filtered, provider)
		}
	}
	e.providers = filtered
}

// MessageRenderer registers a custom message renderer.
func (e *Extension) MessageRenderer(customType string, handler RendererFunc) {
	e.renderers = append(e.renderers, rendererDef{CustomType: customType})
	e.rendererFuncs[customType] = handler
}

// EntryRenderer registers a custom session-entry renderer.
func (e *Extension) EntryRenderer(customType string, handler EntryRendererFunc) {
	e.entryRenderers = append(e.entryRenderers, rendererDef{CustomType: customType})
	e.entryRendererFuncs[customType] = handler
}

// MarkdownTransformer registers the extension's display-only Markdown
// transform (Pi's pi.registerMarkdownTransformer). The host applies it to
// user and assistant Markdown in the interactive transcript, after its own
// transformers; a later registration replaces an earlier one.
func (e *Extension) MarkdownTransformer(transformer MarkdownTransformerFunc) {
	e.markdownTransform = transformer
}

// OnSessionStart registers a handler for the session_start event.
func (e *Extension) OnSessionStart(handler EventFunc) func() {
	return e.OnEvent("session_start", handler)
}

// OnSessionShutdown registers a handler for the session_shutdown event.
func (e *Extension) OnSessionShutdown(handler EventFunc) func() {
	return e.OnEvent("session_shutdown", handler)
}

// OnToolResult registers a handler for the tool_result event.
func (e *Extension) OnToolResult(handler EventFunc) func() {
	return e.OnEvent("tool_result", handler)
}

// OnProjectTrust registers the pre-runtime project_trust handler. Completion,
// cancellation, and errors are awaited by the host.
func (e *Extension) OnProjectTrust(handler ProjectTrustFunc) func() {
	return e.OnEvent("project_trust", func(ctx Context, data map[string]any) (any, error) {
		return handler(ctx, data)
	})
}

// OnEvent registers a handler and returns an idempotent unsubscribe function.
func (e *Extension) OnEvent(eventName string, handler EventFunc) func() {
	e.eventMu.Lock()
	e.eventNextID++
	handlerID := e.eventNextID
	e.handlers = append(e.handlers, handlerDef{Event: eventName, HandlerID: handlerID})
	e.eventFuncs[handlerID] = handler
	conn := e.conn
	e.eventMu.Unlock()

	if conn != nil {
		// Upstream's pi.on throws when the runtime refuses it; this API has no
		// error result, so report the refusal where the host shows extension
		// output instead of dropping it.
		if result, err := conn.call("event.subscribe", map[string]any{"event": eventName, "handlerId": handlerID}); err != nil || (result != nil && result.Error != nil) {
			reportHostCallFailure("event.subscribe", err, result)
		}
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			e.eventMu.Lock()
			conn := e.conn
			if conn == nil {
				for i, declaration := range e.handlers {
					if declaration.HandlerID == handlerID {
						e.handlers = append(e.handlers[:i:i], e.handlers[i+1:]...)
						break
					}
				}
				delete(e.eventFuncs, handlerID)
			}
			e.eventMu.Unlock()
			if conn != nil {
				if result, err := conn.call("event.unsubscribe", map[string]any{"event": eventName, "handlerId": handlerID}); err != nil || (result != nil && result.Error != nil) {
					reportHostCallFailure("event.unsubscribe", err, result)
				}
			}
		})
	}
}

// Run connects to the host, registers, and processes messages until shutdown.
// This blocks until the host sends a shutdown message or the connection closes.
// The socket path comes from the PIG_EXT_SOCKET environment variable.
func (e *Extension) Run() error {
	sockPath := os.Getenv("PIG_EXT_SOCKET")
	if sockPath == "" {
		return fmt.Errorf("PIG_EXT_SOCKET not set: extension must be launched by pig")
	}
	return e.RunWithSocket(sockPath)
}

// RunWithSocket connects to the host at the given socket path. Use this for
// testing extensions without the PIG_EXT_SOCKET environment variable.
func (e *Extension) RunWithSocket(sockPath string) error {
	// The extension author or Pig host selects this local Unix socket; no network URL is resolved.
	//nolint:gosec // G704 models arbitrary network input, not a required local IPC endpoint.
	nc, err := net.Dial("unix", sockPath)
	if err != nil {
		return fmt.Errorf("connect to host: %w", err)
	}
	return e.RunWithConn(nc)
}

// RunWithConn serves the extension over an already-connected net.Conn, with no
// subprocess or socket. A fused Piglet Binary uses this to run the extension
// inside the host process over an in-memory pipe. The connection is closed when the serve
// loop ends. Mirrors RunWithSocket's handshake and main loop.
func (e *Extension) RunWithConn(nc net.Conn) error {
	defer func() { _ = nc.Close() }()

	e.runCtx, e.runCancel = context.WithCancel(context.Background())
	defer e.runCancel()
	e.eventMu.Lock()
	e.conn = newConn(nc)
	conn := e.conn
	e.eventMu.Unlock()
	conn.start()
	defer e.resetEventBus()
	// A node factory's pi.events.on runs before its runtime registers; a native listener subscribed before Run does the same.
	if err := e.registerPendingListeners(conn); err != nil {
		return err
	}

	e.toolMu.Lock()
	defer func() {
		if e.toolConn == nil {
			e.toolMu.Unlock()
		}
	}()
	// Send register message.
	if err := conn.send(envelope{
		Type: msgRegister,
		Register: &registerMsg{
			Name:                    e.name,
			Tools:                   e.tools,
			Commands:                e.commands,
			Shortcuts:               e.shortcuts,
			Handlers:                e.handlers,
			Flags:                   e.flags,
			Providers:               e.providers,
			Renderers:               e.renderers,
			EntryRenderers:          e.entryRenderers,
			MarkdownTransformer:     e.markdownTransform != nil,
			ToolRenderers:           e.toolRendererCount(),
			McpServers:              e.mcpServerDecls,
			VirtualModels:           e.virtualModelDecls,
			UnregisterVirtualModels: e.virtualModelUnregistrations,
		},
	}); err != nil {
		return fmt.Errorf("send register: %w", err)
	}

	// Wait for ready. A listener the Host dispatches to while the extension loads is served here, as a node runtime serves it during its factory.
	var env envelope
	for {
		var ok bool
		env, ok = <-conn.incoming
		if !ok {
			return fmt.Errorf("connection closed before ready")
		}
		if env.Type == msgRequest && env.Request != nil && env.Request.Method == methodEventsDispatch {
			ctx, finish := e.armRequest(env.ID)
			e.requestWG.Go(func() {
				defer finish()
				e.handleArmedRequest(env.ID, env.Request, ctx)
			})
			continue
		}
		// A listener that a load-time dispatch unsubscribed is released as soon as its dispatch ends, which can precede ready.
		if env.Type == msgNotify && env.Notify != nil && env.Notify.Method == notifyEventsRelease {
			e.releaseEventListener(env.Notify.Args)
			e.markNotifyHandled()
			continue
		}
		break
	}
	if env.Type != msgReady || env.Ready == nil {
		return fmt.Errorf("expected ready message, got %s", env.Type)
	}
	e.mu.Lock()
	e.sessionName = env.Ready.SessionName
	e.cwd = env.Ready.Cwd
	e.mode = env.Ready.Mode
	e.width = env.Ready.Width
	e.height = env.Ready.Height
	e.model = env.Ready.Model
	e.mu.Unlock()

	// Process the initial State snapshot embedded in the Ready message.
	// This carries the same model map (including provider) that
	// state_update notifies deliver later, ensuring ModelProvider() and
	// ModelQualified() are populated before session_start fires.
	// Wrap in {"state": ...} to match the state_update notify format.
	if len(env.Ready.State) > 0 {
		wrapped := []byte(`{"state":`)
		wrapped = append(wrapped, env.Ready.State...)
		wrapped = append(wrapped, '}')
		e.handleNotify(envelope{
			Notify: &notifyMsg{
				Method: "state_update",
				Args:   wrapped,
			},
		})
	}

	e.toolConn = conn
	e.toolMu.Unlock()

	// Main message loop.
	return e.loop()
}

func (e *Extension) loop() error {
	for env := range e.conn.incoming {
		switch env.Type {
		case msgRequest:
			ctx, finish := e.armRequest(env.ID)
			if env.Request != nil && env.Request.Method == "tool_call" {
				ctx.start = e.toolStarts.reserve()
			}
			e.requestWG.Go(func() {
				defer finish()
				defer ctx.start.release()
				e.handleArmedRequest(env.ID, env.Request, ctx)
			})
		case msgCancel:
			e.cancelRequest(env)
		case msgNotify:
			e.notifyMu.Lock()
			seq := e.notifyHandled + 1
			e.notifyMu.Unlock()
			e.handleNotifyAt(env, seq)
			e.markNotifyHandled()
		case msgShutdown:
			return e.stopRequests()
		}
	}
	return e.stopRequests()
}

func (e *Extension) stopRequests() error {
	e.stopWidthDeliveries()
	if e.runCancel != nil {
		e.runCancel()
	}
	e.cancelAllRequests()
	if e.conn != nil {
		e.conn.stopCalls()
	}
	done := make(chan struct{})
	go func() {
		e.requestWG.Wait()
		close(done)
	}()
	select {
	case <-done:
		e.autocomplete.mu.Lock()
		e.autocomplete.factories = nil
		e.autocomplete.providers = nil
		e.autocomplete.invoked = nil
		e.autocomplete.mu.Unlock()
		return nil
	case <-time.After(extensionHandlerStopTimeout):
		return errors.New("extension handlers did not stop before the shutdown deadline")
	}
}

func (e *Extension) armRequest(id string) (Context, func()) {
	requestRoot := e.runCtx
	if requestRoot == nil {
		requestRoot = context.Background()
	}
	reqCtx, cancel := context.WithCancel(requestRoot)
	parent := e.conn.armParent(id, requestRoot, reqCtx)
	e.requestsMu.Lock()
	e.requests[id] = cancel
	e.requestsMu.Unlock()
	return Context{ext: e, requestID: id, parent: parent, ctx: reqCtx}, func() {
		e.requestsMu.Lock()
		delete(e.requests, id)
		e.requestsMu.Unlock()
		cancel()
	}
}

func (e *Extension) handleRequest(id string, req *requestMsg) {
	ctx, finish := e.armRequest(id)
	defer finish()
	e.handleArmedRequest(id, req, ctx)
}

func (e *Extension) handleArmedRequest(id string, req *requestMsg, ctx Context) {
	_ = e.conn.requestState(id, "started", "")
	if req == nil {
		_ = e.conn.respond(id, nil, fmt.Errorf("nil request"))
		return
	}

	// A handler runs on its own goroutine (see loop: `go handleRequest`). Without
	// this guard a single panicking handler would crash the whole extension
	// process, silently killing every capability it provides until the user
	// runs /reload. Recover, fail just this request, and keep serving. This
	// mirrors upstream's per-request error isolation (a thrown handler error in
	// the TS runtime rejects one call, it does not tear down the runtime).
	var boundaryData map[string]any
	var promptOptions map[string]any
	var toolCall *toolCallInput
	defer func() {
		if r := recover(); r != nil {
			name := req.Tool
			if name == "" {
				name = req.Event
			}
			fmt.Fprintf(os.Stderr, "extension: recovered from panic in %s %q: %v\n%s\n", req.Method, name, r, debug.Stack())
			var result any
			if boundaryData != nil {
				result = map[string]any{"_pigBoundaryEntries": boundaryData["entries"], "_pigBoundaryResult": nil}
			}
			if toolCall != nil {
				reply := map[string]any{"_pigToolCallResult": nil}
				if edited, ok := toolCall.edit(); ok {
					reply["_pigToolCallInput"] = edited
				}
				result = reply
			}
			if promptOptions != nil {
				result = map[string]any{"_pigPromptSections": promptOptions["sections"], "_pigPromptSelectedTools": promptOptions["selectedTools"], "_pigPromptOptions": promptOptions, "_pigPromptResult": nil}
			}
			_ = e.conn.respond(id, result, fmt.Errorf("handler panicked: %v", r))
		}
	}()

	switch req.Method {
	case "autocomplete.sync", "autocomplete.suggest":
		result, err := e.dispatchAutocomplete(ctx, req.Args)
		_ = e.conn.respond(id, result, err)
	case "provider_stream_simple":
		e.dispatchProviderStream(ctx, id, req)
	case "provider_operation":
		result, err := e.dispatchProviderOperation(ctx, req)
		_ = e.conn.respond(id, result, err)
	case "provider_call", "provider_stream", "provider_sync":
		result, err := e.dispatchProviderObject(ctx, req)
		_ = e.conn.respond(id, result, err)
	case "provider_object_callback", "provider_object_callback_sync":
		result, err := e.dispatchProviderObjectCallback(req)
		_ = e.conn.respond(id, result, err)
	case methodOAuthLogin, methodOAuthRefresh, methodOAuthGetAPIKey,
		methodOAuthCredentialStatus, methodOAuthStoreCredentials, methodOAuthDeleteCredentials:
		e.dispatchOAuth(id, req)

	case "terminal_input":
		e.dispatchTerminalInput(id, req)

	case "virtual_model_route":
		result, err := e.dispatchVirtualModelRoute(ctx, req.Args)
		_ = e.conn.respond(id, result, err)

	case requestExecuteToolUpdate:
		_ = e.conn.respond(id, nil, e.dispatchExecuteToolUpdate(req.Args))

	case "tool_prepare_loadout":
		result, err := e.dispatchPrepareLoadout(req.Tool, req.Args)
		_ = e.conn.respond(id, result, err)

	case methodEventsDispatch:
		e.dispatchEventBus(ctx, id, req)

	case "tool_call":
		e.toolMu.RLock()
		handler, ok := e.toolFuncs[req.Tool]
		e.toolMu.RUnlock()
		if !ok {
			_ = e.conn.respond(id, nil, fmt.Errorf("unknown tool: %s", req.Tool))
			return
		}
		ctx.toolCallID = req.ToolCallID
		var params map[string]any
		if len(req.Args) > 0 {
			if err := json.Unmarshal(req.Args, &params); err != nil {
				_ = e.conn.respond(id, nil, fmt.Errorf("decode tool arguments: %w", err))
				return
			}
		}
		// agent-loop.ts:619-647: the handlers of a batch start in source order.
		ctx.start.begin()
		result, err := handler(ctx, params)
		_ = e.conn.respond(id, result, err)

	case "tool_prepare_arguments":
		// agent-loop.ts:707-716: prepareToolCall runs the hook on the model's arguments and validates what it returns, so the host asks for it before tool_call.
		e.toolMu.RLock()
		prepare := e.toolPrepareFuncs[req.Tool]
		e.toolMu.RUnlock()
		if prepare == nil {
			_ = e.conn.respond(id, nil, fmt.Errorf("tool %s has no prepareArguments", req.Tool))
			return
		}
		var params map[string]any
		if len(req.Args) > 0 {
			if err := json.Unmarshal(req.Args, &params); err != nil {
				_ = e.conn.respond(id, nil, fmt.Errorf("decode tool arguments: %w", err))
				return
			}
		}
		prepared, err := prepare(params)
		_ = e.conn.respond(id, prepared, err)

	case requestWithSession:
		_ = e.conn.respond(id, nil, e.dispatchWithSession(ctx, req.Args))

	case "command":
		handler, ok := e.commandFuncs[req.Tool]
		if !ok {
			_ = e.conn.respond(id, nil, fmt.Errorf("unknown command: %s", req.Tool))
			return
		}
		var args string
		if len(req.Args) > 0 {
			_ = json.Unmarshal(req.Args, &args)
		}
		err := handler(ctx, args)
		_ = e.conn.respond(id, nil, err)

	case "event":
		e.eventMu.Lock()
		handler, ok := e.eventFuncs[req.HandlerID]
		e.eventMu.Unlock()
		if !ok {
			_ = e.conn.respond(id, nil, fmt.Errorf("unknown event handler %d for %s", req.HandlerID, req.Event))
			return
		}
		var data map[string]any
		if len(req.Args) > 0 {
			_ = json.Unmarshal(req.Args, &data)
		}
		if req.Event == "agent_before_settle" || req.Event == "turn_end" {
			boundaryData = data
		}
		if req.Event == "tool_call" {
			var source struct {
				Input json.RawMessage `json:"input"`
			}
			_ = json.Unmarshal(req.Args, &source)
			toolCall = newToolCallInput(data["input"], source.Input)
		}
		if req.Event == "before_agent_start" {
			var err error
			promptOptions, err = preparePromptOptions(req.Args, data)
			if err != nil {
				_ = e.conn.respond(id, nil, err)
				return
			}
		}
		snapshot := snapshotContextMessages(req.Event, data)
		result, err := handler(ctx, data)
		if req.Event == "user_bash" && err == nil {
			result, err = userBashEventResult(result)
		}
		if snapshot != nil && err == nil {
			result = contextEventResult(data, snapshot, result)
		}
		if req.Event == "before_agent_start" {
			result = map[string]any{"_pigPromptSections": promptOptions["sections"], "_pigPromptSelectedTools": promptOptions["selectedTools"], "_pigPromptOptions": promptOptions, "_pigPromptResult": result}
		}
		// Pi's handler edits event.input in place and the runner reads it back (runner.ts emitToolCall). The host cannot share the map, so the reply carries the input the handler left when it differs from the one it received, with the handler result and error.
		if req.Event == "tool_call" {
			reply := map[string]any{"_pigToolCallResult": result}
			if edited, ok := toolCall.edit(); ok {
				reply["_pigToolCallInput"] = edited
			}
			result = reply
		}
		// pig additive (D19): return boundary mutations separately from the handler result and error.
		if req.Event == "agent_before_settle" || req.Event == "turn_end" {
			if err != nil {
				result = nil
			}
			result = map[string]any{"_pigBoundaryEntries": data["entries"], "_pigBoundaryResult": result}
		}
		_ = e.conn.respond(id, result, err)

	case "shortcut":
		handler, ok := e.shortcutFuncs[req.Tool]
		if !ok {
			_ = e.conn.respond(id, nil, fmt.Errorf("unknown shortcut: %s", req.Tool))
			return
		}
		err := handler(ctx)
		_ = e.conn.respond(id, nil, err)

	case "render_message":
		handler, ok := e.rendererFuncs[req.Tool]
		if !ok {
			_ = e.conn.respond(id, nil, fmt.Errorf("unknown renderer: %s", req.Tool))
			return
		}
		var payload struct {
			Message map[string]any       `json:"message"`
			Options MessageRenderOptions `json:"options"`
			Width   int                  `json:"width"`
		}
		if len(req.Args) > 0 {
			_ = json.Unmarshal(req.Args, &payload)
		}
		lines, err := handler(ctx, payload.Message, payload.Options, payload.Width)
		_ = e.conn.respond(id, map[string]any{"lines": lines}, err)

	case "render_entry":
		handler, ok := e.entryRendererFuncs[req.Tool]
		if !ok {
			_ = e.conn.respond(id, nil, fmt.Errorf("unknown entry renderer: %s", req.Tool))
			return
		}
		var payload struct {
			Entry   map[string]any     `json:"entry"`
			Options EntryRenderOptions `json:"options"`
			Width   int                `json:"width"`
		}
		if len(req.Args) > 0 {
			_ = json.Unmarshal(req.Args, &payload)
		}
		lines, err := handler(ctx, payload.Entry, payload.Options, payload.Width)
		_ = e.conn.respond(id, map[string]any{"lines": lines}, err)

	case "markdown_transform":
		_ = e.conn.respond(id, e.transformMarkdown(req.Args), nil)

	case "command_argument_completions":
		items, err := e.commandArgumentCompletions(req.Tool, req.Args)
		_ = e.conn.respond(id, items, err)

	case "render_tool":
		lines, err := e.renderTool(ctx, req.Tool, req.Args)
		_ = e.conn.respond(id, map[string]any{"lines": lines}, err)

	case "resolve_tool_renderers":
		resolved, err := e.resolveToolRenderers(req.Args)
		_ = e.conn.respond(id, resolved, err)

	default:
		_ = e.conn.respond(id, nil, fmt.Errorf("unknown request method: %s", req.Method))
	}
}

// transformMarkdown answers a markdown_transform request: the transformed
// Markdown, or nil to keep the input when there is no transformer or it
// panicked.
func (e *Extension) transformMarkdown(args json.RawMessage) (result any) {
	if e.markdownTransform == nil {
		return nil
	}
	var payload struct {
		Markdown string                   `json:"markdown"`
		Context  MarkdownTransformContext `json:"context"`
	}
	if err := json.Unmarshal(args, &payload); err != nil {
		return nil
	}
	defer func() {
		if recover() != nil {
			result = nil
		}
	}()
	return e.markdownTransform(payload.Markdown, payload.Context)
}

// reportHostCallFailure writes a failed host call the caller cannot return to
// stderr, which the host captures in the extension's log.
func reportHostCallFailure(method string, err error, result *callResultMsg) {
	if err == nil && result != nil && result.Error != nil {
		err = errors.New(result.Error.Message)
	}
	fmt.Fprintf(os.Stderr, "pig: host call %s failed: %v\n", method, err)
}

// markNotifyHandled records that the main loop applied one queued notify frame.
func (e *Extension) markNotifyHandled() {
	e.notifyMu.Lock()
	e.notifyHandled++
	if e.notifyChanged != nil {
		close(e.notifyChanged)
		e.notifyChanged = nil
	}
	e.notifyMu.Unlock()
}

// waitNotifications blocks until the main loop has applied the first target
// queued notify frames, until stop closes, or until the connection closes.
func (e *Extension) waitNotifications(target uint64, stop <-chan struct{}) {
	for {
		e.notifyMu.Lock()
		if e.notifyHandled >= target {
			e.notifyMu.Unlock()
			return
		}
		if e.notifyChanged == nil {
			e.notifyChanged = make(chan struct{})
		}
		changed := e.notifyChanged
		e.notifyMu.Unlock()
		select {
		case <-changed:
		case <-stop:
			return
		case <-e.conn.done:
			return
		}
	}
}

// handleNotify processes broadcast notifications from the host.
// Currently handles "state_update" to keep cached fields (model, thinking,
// etc.) in sync with the host.
func (e *Extension) handleNotify(env envelope) { e.handleNotifyAt(env, 0) }

// handleNotifyAt is handleNotify for the seq-th notify frame the read loop queued; 0 is a state that precedes every frame, such as the ready snapshot.
func (e *Extension) handleNotifyAt(env envelope, seq uint64) {
	if env.Notify == nil {
		return
	}
	switch env.Notify.Method {
	case notifyRunSignal:
		e.run.apply(env.Notify.Args)
	case notifyEventsRelease:
		e.releaseEventListener(env.Notify.Args)
	case "tool_render_release":
		e.releaseToolRenderCard(env.Notify.Args)
	case "provider_release":
		var release struct {
			Key string `json:"key"`
		}
		if json.Unmarshal(env.Notify.Args, &release) == nil {
			e.providerMu.Lock()
			delete(e.nativeProviders, release.Key)
			e.providerMu.Unlock()
		}
	case "autocomplete.release":
		var released struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(env.Notify.Args, &released) == nil {
			e.autocomplete.mu.Lock()
			delete(e.autocomplete.providers, released.ID)
			e.autocomplete.mu.Unlock()
		}
	case "model_stream_event":
		var payload struct {
			StreamID string         `json:"streamId"`
			Event    map[string]any `json:"event"`
			Started  bool           `json:"started"`
		}
		if err := json.Unmarshal(env.Notify.Args, &payload); err != nil {
			return
		}
		e.modelStreamsMu.RLock()
		stream := e.modelStreams[payload.StreamID]
		e.modelStreamsMu.RUnlock()
		if stream != nil {
			if payload.Started {
				stream.markStarted(nil)
			} else {
				stream.push(payload.Event)
			}
		}
	case "state_update":
		var payload struct {
			State struct {
				HasUI      *bool           `json:"hasUI"`
				Model      map[string]any  `json:"model"`
				Session    json.RawMessage `json:"session"`
				Theme      json.RawMessage `json:"theme"`
				Settings   json.RawMessage `json:"settings"`
				McpServers json.RawMessage `json:"mcpServers"`
			} `json:"state"`
		}
		if err := json.Unmarshal(env.Notify.Args, &payload); err != nil {
			return
		}
		// Session replication: apply incremental entries before any handler
		// runs, so GetBranch()/GetEntries() are current and local.
		var sessionState struct {
			SessionFile string `json:"sessionFile"`
		}
		if len(payload.State.Session) > 0 {
			_ = json.Unmarshal(payload.State.Session, &sessionState)
		}
		e.session.applySessionUpdate(payload.State.Session)

		e.mu.Lock()
		if payload.State.HasUI != nil {
			e.hasUI = *payload.State.HasUI
		}
		if sessionState.SessionFile != "" {
			e.sessionFile = sessionState.SessionFile
		}
		if theme, ok := decodeUITheme(payload.State.Theme); ok {
			e.uiTheme = theme
		}
		e.applyReplicatedState(payload.State.Settings, payload.State.McpServers, 2*seq)
		defer e.mu.Unlock()
		if m := payload.State.Model; m != nil {
			if id, ok := m["id"].(string); ok && id != "" {
				e.model = id
			} else if name, ok := m["name"].(string); ok && name != "" {
				e.model = name
			}
			// Extract provider ID from nested {"provider": {"id": "..."}}
			// or flat {"provider": "..."}.
			if prov, ok := m["provider"]; ok {
				switch v := prov.(type) {
				case map[string]any:
					if pid, ok := v["id"].(string); ok {
						e.modelProvider = pid
					}
				case string:
					e.modelProvider = v
				}
			}
		}
	case "theme_change":
		// A palette sent as a JSON string is parsed, and one that is not an
		// object resets to an empty palette, as the Node runtime does.
		args := env.Notify.Args
		var encoded string
		if json.Unmarshal(args, &encoded) == nil {
			args = json.RawMessage(encoded)
		}
		theme, ok := decodeUITheme(args)
		if !ok {
			theme, _ = decodeUITheme(json.RawMessage(`{}`))
		}
		e.mu.Lock()
		e.uiTheme = theme
		e.mu.Unlock()
	case "width_change":
		var payload struct {
			Width int `json:"width"`
		}
		if err := json.Unmarshal(env.Notify.Args, &payload); err != nil {
			return
		}
		if payload.Width > 0 {
			e.mu.Lock()
			e.width = payload.Width
			e.mu.Unlock()
			e.notifyWidthChange(payload.Width)
			e.refreshSurfaces()
			e.overlaysMu.RLock()
			overlays := make(map[string]*remoteOverlay, len(e.overlays))
			maps.Copy(overlays, e.overlays)
			e.overlaysMu.RUnlock()
			for _, overlay := range overlays {
				overlay.requestRender()
			}
		}
	case "height_change":
		var payload struct {
			Height int `json:"height"`
		}
		if err := json.Unmarshal(env.Notify.Args, &payload); err != nil {
			return
		}
		if payload.Height > 0 {
			e.mu.Lock()
			e.height = payload.Height
			e.mu.Unlock()
		}
	case "ui.custom.input":
		var payload struct {
			Key  string `json:"key"`
			Data string `json:"data"`
		}
		if err := json.Unmarshal(env.Notify.Args, &payload); err != nil || payload.Key == "" {
			return
		}
		e.overlaysMu.RLock()
		overlay := e.overlays[payload.Key]
		e.overlaysMu.RUnlock()
		if overlay != nil {
			overlay.enqueueInput(e.conn, payload.Key, payload.Data)
		}
	}
}

func (e *Extension) cancelRequest(env envelope) {
	id := env.ID
	if id == "" && env.Cancel != nil {
		id = env.Cancel.RequestID
	}
	if id == "" {
		return
	}
	e.requestsMu.Lock()
	cancel := e.requests[id]
	e.requestsMu.Unlock()
	if e.conn != nil {
		e.conn.cancelParentCalls(id)
	}
	if cancel != nil {
		cancel()
	}
}

func (e *Extension) cancelAllRequests() {
	e.requestsMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(e.requests))
	for _, cancel := range e.requests {
		cancels = append(cancels, cancel)
	}
	e.requests = make(map[string]context.CancelFunc)
	e.requestsMu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

// ── Typed parameter helpers ──────────────────────────────────────────────────

// Param extracts a typed parameter from the params map.
// Returns the zero value if the key is missing or the wrong type.
func Param[T any](params map[string]any, key string) T {
	v, ok := params[key]
	if !ok {
		var zero T
		return zero
	}
	typed, ok := v.(T)
	if !ok {
		var zero T
		return zero
	}
	return typed
}

// ToolError is a structured error return from a tool handler.
// When returned from a ToolFunc, the host displays it as a tool error
// with the content visible to the LLM.
type ToolError struct {
	Content string // Error message visible to the LLM
}

func (e *ToolError) Error() string { return e.Content }

// NewToolError creates a structured tool error.
func NewToolError(content string) *ToolError {
	return &ToolError{Content: content}
}

// ToolResult is a structured result from a tool handler with optional
// preview and details. When returned from a ToolFunc:
//   - Content is sent to the LLM as the tool result
//   - Preview (if non-empty) is shown in the TUI when collapsed;
//     Ctrl+O expands to show full Content. Without Preview, the TUI
//     shows a generic tail-of-output preview.
//   - Details is optional structured data for per-tool renderers
//
// For simple string results, returning the string directly from
// ToolFunc is equivalent to ToolResult{Content: s}.
//
// Images follow Content as upstream image blocks, and Terminate mirrors
// upstream's terminate: the agent stops after the current tool batch when every
// result in it sets Terminate.
//
// IsError is upstream's isError: the model sees Content as an error result, like a thrown error, and Details and StructuredContent are kept.
//
// Usage is upstream AgentToolResult.usage: the tool execution's own model
// usage, in upstream's Usage JSON shape (input, output, cacheRead, cacheWrite,
// totalTokens, cost). Nil leaves it unset.
type ToolResult struct {
	Content string
	Images  []ImageContent
	Preview string
	Details any
	// StructuredContent is upstream AgentToolResult.structuredContent: the machine-readable result matching the tool's OutputSchema, for programmatic callers. It is not sent to the model. Nil leaves it unset.
	StructuredContent any
	IsError           bool
	Usage             any
	Terminate         bool
}

// ImageContent is an image block in a tool result, mirroring upstream's
// ImageContent.
type ImageContent struct {
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

// MarshalJSON writes the wire tool result. Content stays a string unless the
// result carries images, which need upstream's block array.
func (r ToolResult) MarshalJSON() ([]byte, error) {
	type block struct {
		Type     string `json:"type"`
		Text     string `json:"text,omitempty"`
		Data     string `json:"data,omitempty"`
		MimeType string `json:"mimeType,omitempty"`
	}
	var content any = r.Content
	if len(r.Images) > 0 {
		blocks := make([]block, 0, len(r.Images)+1)
		if r.Content != "" {
			blocks = append(blocks, block{Type: "text", Text: r.Content})
		}
		for _, image := range r.Images {
			blocks = append(blocks, block{Type: "image", Data: image.Data, MimeType: image.MimeType})
		}
		content = blocks
	}
	return json.Marshal(struct {
		Content           any    `json:"content"`
		Preview           string `json:"preview,omitempty"`
		Details           any    `json:"details,omitempty"`
		StructuredContent any    `json:"structured_content,omitempty"`
		IsError           bool   `json:"is_error,omitempty"`
		Usage             any    `json:"usage,omitempty"`
		Terminate         bool   `json:"terminate,omitempty"`
	}{content, r.Preview, r.Details, r.StructuredContent, r.IsError, r.Usage, r.Terminate})
}

// widthChangeSub pairs a width handler with the token used to remove it.
type widthChangeSub struct {
	id      uint64
	handler WidthChangeHandler
}

// terminalInputSub pairs a raw-input handler with the token used to remove it.
type terminalInputSub struct {
	id      uint64
	handler TerminalInputHandler
}

// dispatchTerminalInput answers the host's consume question for one input
// chunk. The host is blocked on this reply and upstream's handler is
// synchronous, so handlers run inline and a panicking handler degrades to
// not-consumed rather than capturing the user's keystroke.
func (e *Extension) dispatchTerminalInput(id string, req *requestMsg) {
	var args struct {
		Data string `json:"data"`
	}
	if len(req.Args) > 0 {
		_ = json.Unmarshal(req.Args, &args)
	}

	e.terminalInputMu.RLock()
	subs := slices.Clone(e.terminalInputFuncs)
	e.terminalInputMu.RUnlock()

	current := args.Data
	for _, sub := range subs {
		result := runTerminalInputHandler(sub.handler, current)
		if result.Consume {
			_ = e.conn.respond(id, map[string]any{"consume": true}, nil)
			return
		}
		if result.Data != nil {
			current = *result.Data
		}
	}
	verdict := map[string]any{"consume": false}
	if current != args.Data {
		verdict["data"] = current
	}
	_ = e.conn.respond(id, verdict, nil)
}

// runTerminalInputHandler isolates one handler so a panic cannot swallow the
// keystroke or take down the extension; a panic yields no verdict.
func runTerminalInputHandler(handler TerminalInputHandler, data string) (result TerminalInputResult) {
	defer func() {
		if recover() != nil {
			result = TerminalInputResult{}
		}
	}()
	return handler(data)
}

func readSessionEntries(path string) []json.RawMessage {
	if path == "" {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer func() { _ = file.Close() }()
	var entries []json.RawMessage
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 128*1024*1024)
	for scanner.Scan() {
		raw := bytes.Clone(scanner.Bytes())
		if !json.Valid(raw) {
			return nil
		}
		if len(entries) == 0 {
			var identity struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &identity) != nil {
				return nil
			}
			if identity.Type == "session" {
				continue
			}
		}
		entries = append(entries, raw)
	}
	if scanner.Err() != nil {
		return nil
	}
	return entries
}

// ensureSessionLog enrolls this extension in session-log replication the first
// time it reads the log, and blocks until the backlog is installed so the
// readers above it stay synchronous.
//
// Extensions start unsubscribed because the host would otherwise replicate the
// whole session into every loaded extension, including the majority that only
// ever ask for a session id or act on events. On a large session that is the
// difference between a few megabytes and hundreds per extension.
func (e *Extension) ensureSessionLog() error {
	e.session.subMu.Lock()
	defer e.session.subMu.Unlock()
	if e.session.subscribed.Load() {
		return e.session.subErr
	}
	// Mark subscribed before the call, not after. The host starts sending the
	// log the moment it registers the subscription, and those pushes must be
	// applied rather than dropped. It also stands regardless of outcome: a host
	// that cannot serve the log will not serve a retry either, and retrying on
	// every read would turn a local read back into an IPC call per event. The
	// failure is kept and returned by every read instead of an empty mirror.
	e.session.subscribed.Store(true)
	if e.conn == nil {
		return nil
	}
	e.session.subErr = e.subscribeSessionLog()
	return e.session.subErr
}

func (e *Extension) subscribeSessionLog() error {
	type sessionPage struct {
		Entries    []json.RawMessage `json:"entries"`
		EntryCount int               `json:"entryCount"`
		HasMore    bool              `json:"hasMore"`
		LeafID     string            `json:"leafId"`
	}
	fetch := func(cursor int, complete bool) (sessionPage, error) {
		var page sessionPage
		result, err := e.conn.call("watchSessionLog", map[string]any{"cursor": cursor, "complete": complete})
		if err := callResultError(result, err); err != nil {
			return page, fmt.Errorf("watchSessionLog: %w", err)
		}
		if result == nil {
			return page, errors.New("watchSessionLog: host returned no result")
		}
		if err := json.Unmarshal(result.Result, &page); err != nil {
			return page, fmt.Errorf("watchSessionLog: %w", err)
		}
		return page, nil
	}

	e.mu.RLock()
	entries := readSessionEntries(e.sessionFile)
	e.mu.RUnlock()
	cursor := len(entries)
	leafID := ""
	for {
		requestedCursor := cursor
		page, err := fetch(cursor, false)
		if err != nil {
			return err
		}
		if page.EntryCount-len(page.Entries) != requestedCursor {
			entries = nil
		}
		entries = append(entries, page.Entries...)
		cursor = page.EntryCount
		leafID = page.LeafID
		if !page.HasMore {
			break
		}
	}
	e.session.seed(entries, cursor, leafID)

	for {
		requestedCursor := cursor
		page, err := fetch(cursor, true)
		if err != nil {
			return err
		}
		if page.EntryCount-len(page.Entries) != requestedCursor {
			entries = nil
		}
		entries = append(entries, page.Entries...)
		cursor = page.EntryCount
		leafID = page.LeafID
		e.session.seed(entries, cursor, leafID)
		if !page.HasMore && len(page.Entries) == 0 {
			return nil
		}
	}
}

// widthDelivery is one width and the handlers subscribed when it arrived.
type widthDelivery struct {
	width int
	subs  []widthChangeSub
}

// notifyWidthChange queues width handlers to run after e.width is updated, so a handler that calls Context.Width observes that width or a newer one. A handler may block on a host call, whose reply the read loop routes and whose notifies the message loop applies, so handlers run on their own goroutine: one at a time, in the order the host sent the widths. An unsubscribe after this call changes only the next delivery.
func (e *Extension) notifyWidthChange(width int) {
	e.widthChangeMu.RLock()
	subs := slices.Clone(e.widthChangeFuncs)
	e.widthChangeMu.RUnlock()
	if len(subs) == 0 {
		return
	}
	e.widthMu.Lock()
	defer e.widthMu.Unlock()
	if e.widthStopped {
		return
	}
	e.widthDeliveries = append(e.widthDeliveries, widthDelivery{width: width, subs: subs})
	if e.widthRunning {
		return
	}
	e.widthRunning = true
	e.requestWG.Go(e.runWidthDeliveries)
}

// runWidthDeliveries delivers queued widths until none is left.
func (e *Extension) runWidthDeliveries() {
	ctx := Context{ext: e}
	for {
		e.widthMu.Lock()
		if len(e.widthDeliveries) == 0 || e.widthStopped {
			e.widthDeliveries = nil
			e.widthRunning = false
			e.widthMu.Unlock()
			return
		}
		delivery := e.widthDeliveries[0]
		e.widthDeliveries = e.widthDeliveries[1:]
		e.widthMu.Unlock()
		for _, sub := range delivery.subs {
			e.callWidthHandler(ctx, sub.handler, delivery.width)
		}
	}
}

// callWidthHandler isolates one handler's panic, as a handler panic fails one request and not the process.
func (e *Extension) callWidthHandler(ctx Context, handler WidthChangeHandler, width int) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "extension: recovered from panic in a width change handler: %v\n%s\n", r, debug.Stack())
		}
	}()
	handler(ctx, width)
}

// stopWidthDeliveries drops the queued widths; the running handler finishes, and stopRequests waits for it.
func (e *Extension) stopWidthDeliveries() {
	e.widthMu.Lock()
	e.widthStopped = true
	e.widthDeliveries = nil
	e.widthMu.Unlock()
}

// toolCallInput is the input a tool_call handler received. The tool runs with that object (agent-loop.ts prepareToolCall passes the same args to beforeToolCall and execute), so an edit counts only when the handler changed its members; assigning another value to event["input"] changes nothing the tool receives. source is the input as the host wrote it, which gives the member order an edit keeps.
type toolCallInput struct {
	input  any
	source json.RawMessage
	before []byte
}

func newToolCallInput(input any, source json.RawMessage) *toolCallInput {
	before, _ := json.Marshal(input)
	return &toolCallInput{input: input, source: source, before: before}
}

// edit returns the input as JSON when the handler left its members different from the ones it received. A retained member keeps the place it had, as an assignment to a JavaScript object leaves it.
func (t *toolCallInput) edit() (any, bool) {
	after, err := json.Marshal(t.input)
	if err != nil || bytes.Equal(after, t.before) {
		return nil, false
	}
	ordered, err := marshalInSourceOrder(t.input, t.source)
	if err != nil {
		return t.input, true
	}
	return json.RawMessage(ordered), true
}
