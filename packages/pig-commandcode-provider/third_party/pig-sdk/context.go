package sdk

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// ErrUnsupportedSubprocessUI is returned for UI methods whose upstream API
// requires passing live callbacks or component factories across the extension
// boundary. The subprocess SDK cannot serialize those closures today.
var ErrUnsupportedSubprocessUI = errors.New("unsupported in subprocess SDK")

// WorkingIndicatorOptions mirrors upstream's loose shape. The host treats this
// as an opaque JSON object.
type WorkingIndicatorOptions = map[string]any

// WidgetOptions is an opaque type mirroring upstream's ExtensionWidgetOptions.
type WidgetOptions = map[string]any

// TerminalInputResult is a raw-input handler's verdict on one chunk, mirroring
// upstream's `{ consume?: boolean; data?: string }`.
type TerminalInputResult struct {
	// Consume suppresses normal handling of the chunk, so the editor and
	// keybindings never see it.
	Consume bool
	// Data, when non-nil, replaces the chunk for later handlers and for normal
	// handling. An empty replacement drops the chunk.
	Data *string
}

// WidthChangeHandler receives the new terminal width after a resize.
//
// Header, footer, and widget lines are sent to the host as static strings, so
// unlike upstream's component factories they are not re-rendered when the
// terminal resizes. An extension that owns any of them re-pushes from here.
type WidthChangeHandler func(ctx Context, width int)

// TerminalInputHandler receives JavaScript UTF-16 chunks; lone surrogates use WTF-8 in Go strings.
// It mirrors upstream's TerminalInputHandler. Like upstream's
// synchronous listener, the input waits for the verdict, so a handler should
// return promptly.
type TerminalInputHandler func(data string) TerminalInputResult

// RemoteComponent is the serializable subprocess form of an upstream custom
// TUI component. The SDK renders it locally, sends only terminal lines to the
// host, and routes input back only while the host overlay owns focus.
type RemoteComponent interface {
	Render(width int) []string
	HandleInput(data string) (RemoteComponentResult, error)
}

// RemoteComponentResult closes a focused component when Done is true. Value
// must be JSON-serializable and becomes the result returned by [Context.Custom].
type RemoteComponentResult struct {
	Done  bool
	Value any
}

// RemoteComponentInvalidator is implemented by a component that changes without
// terminal input. The SDK installs a bounded render callback while the overlay
// is active and clears it before disposal. Implementations must replace the
// callback and treat nil as detach.
type RemoteComponentInvalidator interface {
	SetInvalidate(func())
}

// RemoteComponentDisposer is implemented by components that own resources.
// Dispose runs once when the overlay closes, the extension disconnects, or the
// host tears it down during reload.
type RemoteComponentDisposer interface {
	Dispose()
}

// RemoteOverlayOptions is the serializable subset of upstream overlay options.
type RemoteOverlayOptions struct {
	Title          string  `json:"title,omitempty"`
	WidthFraction  float64 `json:"widthFraction,omitempty"`
	HeightFraction float64 `json:"heightFraction,omitempty"`
	// Overlay opens the component as a floating viewport overlay instead of
	// replacing the inline editor slot. Mirrors upstream ui.custom() overlay.
	Overlay bool `json:"overlay,omitempty"`
	// OverlayOptions is upstream ui.custom()'s overlayOptions: the overlay's
	// position and size. Nil leaves them to the host's defaults.
	OverlayOptions *OverlayOptions `json:"overlayOptions,omitempty"`
}

// OverlayOptions is the serializable subset of upstream pi-tui OverlayOptions:
// every field except the visible callback.
type OverlayOptions struct {
	// Width is the overlay width in cells or a percentage of the terminal.
	Width *OverlaySize `json:"width,omitempty"`
	// MinWidth is the minimum overlay width in cells.
	MinWidth int `json:"minWidth,omitempty"`
	// MaxHeight caps the overlay height in rows or a percentage of the
	// terminal.
	MaxHeight *OverlaySize `json:"maxHeight,omitempty"`
	// Anchor positions the overlay: "center", "top-left", "top-right",
	// "bottom-left", "bottom-right", "top-center", "bottom-center",
	// "left-center" or "right-center".
	Anchor string `json:"anchor,omitempty"`
	// OffsetX and OffsetY shift the overlay from its anchored position.
	OffsetX int `json:"offsetX,omitempty"`
	OffsetY int `json:"offsetY,omitempty"`
	// Row and Col position the overlay absolutely, in cells or a percentage.
	Row *OverlaySize `json:"row,omitempty"`
	Col *OverlaySize `json:"col,omitempty"`
	// Margin keeps the overlay away from the terminal edges.
	Margin *OverlayMargin `json:"margin,omitempty"`
	// NonCapturing leaves keyboard focus where it is.
	NonCapturing bool `json:"nonCapturing,omitempty"`
}

// OverlaySize is upstream SizeValue: a cell count or a percentage of the
// terminal ("50%"). Build one with [OverlayCells] or [OverlayPercent].
type OverlaySize struct {
	Value   float64
	Percent bool
}

// OverlayCells is a size of n cells.
func OverlayCells(n int) *OverlaySize { return &OverlaySize{Value: float64(n)} }

// OverlayPercent is a size of pct percent of the terminal.
func OverlayPercent(pct float64) *OverlaySize { return &OverlaySize{Value: pct, Percent: true} }

// MarshalJSON writes a number, or an "N%" string for a percentage.
func (v OverlaySize) MarshalJSON() ([]byte, error) {
	if v.Percent {
		return json.Marshal(strconv.FormatFloat(v.Value, 'f', -1, 64) + "%")
	}
	return json.Marshal(v.Value)
}

// OverlayMargin is upstream `OverlayMargin | number`: All sets every edge,
// otherwise each edge is set on its own.
type OverlayMargin struct {
	All                      *int
	Top, Right, Bottom, Left int
}

// MarshalJSON writes a number for All, else the per-edge object.
func (m OverlayMargin) MarshalJSON() ([]byte, error) {
	if m.All != nil {
		return json.Marshal(*m.All)
	}
	return json.Marshal(map[string]int{"top": m.Top, "right": m.Right, "bottom": m.Bottom, "left": m.Left})
}

// ThemeMeta mirrors upstream getAllThemes() return elements.
type ThemeMeta struct {
	Name string `json:"name"`
	Path string `json:"path,omitempty"`
}

// Theme is the SDK-side opaque type for a theme payload returned by GetTheme.
type Theme = any

func callResultError(result *callResultMsg, err error) error {
	if err != nil {
		return err
	}
	if result != nil && result.Error != nil {
		if result.Error.Code != "" {
			return fmt.Errorf("%s: %s", result.Error.Code, result.Error.Message)
		}
		return fmt.Errorf("%s", result.Error.Message)
	}
	return nil
}

// hostDecoded decodes a host call's reply with the SDK's JSON package, which keeps unmatched UTF-16 units. A host or transport failure is an error.
func hostDecoded[T any](c Context, method string, args any) (T, error) {
	var value T
	result, err := c.callHost(method, args)
	if err := callResultError(result, err); err != nil {
		return value, err
	}
	if result == nil {
		return value, errors.New("host returned no result")
	}
	if err := json.Unmarshal(result.Result, &value); err != nil {
		return value, fmt.Errorf("host reply to %s: %w", method, err)
	}
	return value, nil
}

// hostOptional returns one field of a host reply object, and whether it was present and not null.
func hostOptional[T any](c Context, method string, args any, field string) (T, bool, error) {
	var value T
	fields, err := hostDecoded[map[string]json.RawMessage](c, method, args)
	if err != nil {
		return value, false, err
	}
	raw, ok := fields[field]
	if !ok || string(raw) == "null" {
		return value, false, nil
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, false, fmt.Errorf("host reply to %s field %q: %w", method, field, err)
	}
	return value, true, nil
}

// hostRequired returns a field every reply of the method carries; its absence is a protocol error, not an empty value.
func hostRequired[T any](c Context, method string, args any, field string) (T, error) {
	value, present, err := hostOptional[T](c, method, args, field)
	if err == nil && !present {
		err = fmt.Errorf("host reply to %s has no %q", method, field)
	}
	return value, err
}

// hostOptionalString maps Pi's `string | undefined` getters: the wire carries an empty string for absent state.
func hostOptionalString(c Context, method, field string) (*string, error) {
	value, present, err := hostOptional[string](c, method, nil, field)
	if err != nil || !present || value == "" {
		return nil, err
	}
	return &value, nil
}

// Context provides the extension handler with access to host UI methods,
// session state, and message injection. It is passed to every tool, command,
// and event handler.
type Context struct {
	ext        *Extension
	toolCallID string // set for tool handlers
	requestID  string
	parent     *requestParent
	ctx        context.Context
	start      *toolStart // set for a tool_call request: its place in the order the handlers start
	// replacement is set for a withSession context: the replacement Session's locally answered values.
	replacement *replacementState
}

// RegisterTool registers a model-callable tool and waits for the host registry refresh. It shares Extension.RegisterTool's validation and panic behavior.
func (c Context) RegisterTool(definition ToolDefinition) {
	c.ext.RegisterTool(definition)
}

// Done observes active request cancellation. After normal completion, later reads observe the captured runtime lifetime instead of normal request cleanup.
func (c Context) Done() <-chan struct{} {
	if c.parent != nil {
		if owner, completed := c.parent.lifetime(); completed {
			if owner.Done() != nil {
				return owner.Done()
			}
			return c.parent.conn.done
		}
	}
	if c.ctx == nil {
		return nil
	}
	return c.ctx.Done()
}

// Err reports active request cancellation or invalidation of the captured runtime. Normal response publication does not invalidate a retained Context.
func (c Context) Err() error {
	if c.parent != nil {
		if owner, completed := c.parent.lifetime(); completed {
			select {
			case <-c.parent.conn.done:
				return errors.New("extension connection closed")
			default:
				return owner.Err()
			}
		}
	}
	if c.ctx == nil {
		return nil
	}
	return c.ctx.Err()
}

func (c Context) callHost(method string, args any) (*callResultMsg, error) {
	return c.callHostAfterBegin(method, args, false, nil)
}

// callHostAfterBegin is callHost that runs sent once the call's frame is written and before it waits for the result, so a follow-up call of the caller is ordered after the call. A detached call is not tied to the handler's request: cancelling the request neither cancels it on the host nor ends the wait.
func (c Context) callHostAfterBegin(method string, args any, detached bool, sent func()) (*callResultMsg, error) {
	if method != "ui.select" && method != "ui.confirm" && method != "ui.input" && method != "ui.editor" && method != "ui.custom" {
		c.reportRequestState("blocked", "host_call")
	}
	var pending pendingCall
	var err error
	if detached {
		pending, err = c.hostConnection().beginCallFor("", method, args)
	} else {
		pending, err = c.beginHostCall(method, args)
	}
	if err != nil {
		return nil, err
	}
	if sent != nil {
		sent()
	}
	result, err := c.hostConnection().waitCall(pending)
	c.reportRequestState("progress", "")
	return result, err
}

func (c Context) reportRequestState(state, reason string) {
	if c.parent != nil {
		c.parent.report(state, reason)
		return
	}
	if c.ext == nil || c.ext.conn == nil || c.requestID == "" {
		return
	}
	_ = c.ext.conn.requestState(c.requestID, state, reason)
}

// ── Notifications & Status ───────────────────────────────────────────────────

// Notify shows a notification to the user.
// Level is one of "info", "warning", "error".
func (c Context) Notify(message, level string) {
	_, _ = c.callHost("ui.notify", map[string]string{
		"message": message,
		"level":   level,
	})
}

// SetStatus sets a status text in the footer/status bar.
// Empty text clears the entry for this key.
func (c Context) SetStatus(key, text string) {
	_, _ = c.callHost("ui.setStatus", map[string]string{
		"key":  key,
		"text": text,
	})
}

// SetWorkingMessage sets the message shown during LLM streaming.
func (c Context) SetWorkingMessage(message string) {
	_, _ = c.callHost("ui.setWorkingMessage", map[string]string{
		"message": message,
	})
}

// SetWorkingVisible toggles whether the working indicator is shown.
func (c Context) SetWorkingVisible(visible bool) {
	_, _ = c.callHost("ui.setWorkingVisible", map[string]bool{
		"visible": visible,
	})
}

// SetWorkingIndicator configures the interactive working indicator.
func (c Context) SetWorkingIndicator(options WorkingIndicatorOptions) error {
	result, err := c.callHost("ui.setWorkingIndicator", options)
	return callResultError(result, err)
}

// SetHiddenThinkingLabel sets the label shown for hidden thinking blocks.
func (c Context) SetHiddenThinkingLabel(label string) error {
	result, err := c.callHost("ui.setHiddenThinkingLabel", map[string]string{
		"label": label,
	})
	return callResultError(result, err)
}

// SetTitle sets the terminal window/tab title.
func (c Context) SetTitle(title string) {
	_, _ = c.callHost("ui.setTitle", map[string]string{
		"title": title,
	})
}

// ── User Interaction (blocking) ──────────────────────────────────────────────

// Select shows a selector and returns the user's choice.
// Returns ("", false, nil) if cancelled and a non-nil error when the host UI call fails.
func (c Context) Select(title string, options []string) (string, bool, error) {
	return c.selectDialog(map[string]any{"title": title, "options": options})
}

// DialogOptions mirrors the serializable part of upstream
// ExtensionUIDialogOptions. The dialog's AbortSignal is the request's
// cancellation.
type DialogOptions struct {
	// Timeout auto-dismisses the dialog after this many milliseconds, with a
	// live countdown. Pi's timeout is a JavaScript number, so fractional and
	// very large values are preserved. In interactive mode only a positive
	// value starts a countdown; in RPC mode any non-zero value arms Node's
	// timer, as Pi does. Zero is omitted.
	Timeout float64 `json:"timeout,omitempty"`
}

// SelectWithOptions is [Context.Select] with upstream's dialog options.
func (c Context) SelectWithOptions(title string, options []string, opts DialogOptions) (string, bool, error) {
	return c.selectDialog(map[string]any{"title": title, "options": options, "opts": opts})
}

// ConfirmWithOptions is [Context.Confirm] with upstream's dialog options.
func (c Context) ConfirmWithOptions(title, message string, opts DialogOptions) (bool, error) {
	return c.confirmDialog(map[string]any{"title": title, "message": message, "opts": opts})
}

// InputWithOptions is [Context.Input] with upstream's dialog options.
func (c Context) InputWithOptions(title, placeholder string, opts DialogOptions) (string, bool, error) {
	return c.inputDialog(map[string]any{"title": title, "placeholder": placeholder, "opts": opts})
}

func (c Context) selectDialog(args map[string]any) (string, bool, error) {
	c.reportRequestState("blocked", "user")
	result, err := c.callHost("ui.select", args)
	if err := callResultError(result, err); err != nil {
		return "", false, err
	}
	var resp struct {
		Selected string `json:"selected"`
		Ok       bool   `json:"ok"`
	}
	_ = json.Unmarshal(result.Result, &resp)
	return resp.Selected, resp.Ok, nil
}

// Confirm shows a yes/no confirmation dialog and surfaces host UI failures.
func (c Context) Confirm(title, message string) (bool, error) {
	return c.confirmDialog(map[string]any{"title": title, "message": message})
}

func (c Context) confirmDialog(args map[string]any) (bool, error) {
	c.reportRequestState("blocked", "user")
	result, err := c.callHost("ui.confirm", args)
	if err := callResultError(result, err); err != nil {
		return false, err
	}
	var resp struct {
		Confirmed bool `json:"confirmed"`
	}
	_ = json.Unmarshal(result.Result, &resp)
	return resp.Confirmed, nil
}

// Input shows a text input dialog.
// Returns ("", false, nil) if cancelled and a non-nil error when the host UI call fails.
func (c Context) Input(title, placeholder string) (string, bool, error) {
	return c.inputDialog(map[string]any{"title": title, "placeholder": placeholder})
}

func (c Context) inputDialog(args map[string]any) (string, bool, error) {
	c.reportRequestState("blocked", "user")
	result, err := c.callHost("ui.input", args)
	if err := callResultError(result, err); err != nil {
		return "", false, err
	}
	var resp struct {
		Text string `json:"text"`
		Ok   bool   `json:"ok"`
	}
	_ = json.Unmarshal(result.Result, &resp)
	return resp.Text, resp.Ok, nil
}

// Editor opens a multi-line editor.
// Returns ("", false, nil) if cancelled and a non-nil error when the host UI call fails.
func (c Context) Editor(title, prefill string) (string, bool, error) {
	c.reportRequestState("blocked", "user")
	result, err := c.callHost("ui.editor", map[string]any{
		"title":   title,
		"prefill": prefill,
	})
	if err := callResultError(result, err); err != nil {
		return "", false, err
	}
	var resp struct {
		Text string `json:"text"`
		Ok   bool   `json:"ok"`
	}
	_ = json.Unmarshal(result.Result, &resp)
	return resp.Text, resp.Ok, nil
}

// ── Message Injection ────────────────────────────────────────────────────────

// SendMessageOptions configures how the message is delivered.
//
// Both fields are optional, as upstream's are: a nil TriggerTurn or empty
// DeliverAs is sent as unset, and the host applies upstream's default for the
// session's state (while a turn streams, an unset triggerTurn steers).
type SendMessageOptions struct {
	TriggerTurn *bool  // nil: host default; true starts or joins a turn; false never does
	DeliverAs   string // "steer", "followUp", or "nextTurn"; empty: host default
}

// SendMessage injects a custom message into the conversation.
func (c Context) SendMessage(customType, content string, display bool, opts SendMessageOptions) error {
	options := map[string]any{}
	if opts.TriggerTurn != nil {
		options["triggerTurn"] = *opts.TriggerTurn
	}
	if opts.DeliverAs != "" {
		options["deliverAs"] = opts.DeliverAs
	}
	result, err := c.callHost("sendMessage", map[string]any{
		"message": map[string]any{
			"customType": customType,
			"content":    content,
			"display":    display,
		},
		"options": options,
	})
	if err != nil {
		return err
	}
	if err := callResultError(result, nil); err != nil {
		return err
	}
	return nil
}

// CustomMessage mirrors the message argument of upstream pi.sendMessage.
type CustomMessage struct {
	// CustomType identifies the message for renderers and filters.
	CustomType string
	// Content is a string or an array of text/image content blocks
	// (for example []map[string]any{{"type": "text", "text": "hi"}}).
	Content any
	// Display shows the message in the transcript.
	Display bool
	// Details is optional structured data for the message's renderer; nil
	// leaves it unset.
	Details any
}

// SendCustomMessage injects a custom message into the conversation, as
// upstream pi.sendMessage does, with block content and details.
func (c Context) SendCustomMessage(msg CustomMessage, opts SendMessageOptions) error {
	options := map[string]any{}
	if opts.TriggerTurn != nil {
		options["triggerTurn"] = *opts.TriggerTurn
	}
	if opts.DeliverAs != "" {
		options["deliverAs"] = opts.DeliverAs
	}
	message := map[string]any{
		"customType": msg.CustomType,
		"content":    msg.Content,
		"display":    msg.Display,
	}
	if msg.Details != nil {
		message["details"] = msg.Details
	}
	result, err := c.callHost("sendMessage", map[string]any{
		"message": message,
		"options": options,
	})
	if err != nil {
		return err
	}
	if err := callResultError(result, nil); err != nil {
		return err
	}
	return nil
}

// SendUserMessage injects a user message containing a string or text/image content blocks.
func (c Context) SendUserMessage(content any, deliverAs string) error {
	result, err := c.callHost("sendUserMessage", map[string]any{
		"content": content,
		"options": map[string]any{"deliverAs": deliverAs},
	})
	if err != nil {
		return err
	}
	if err := callResultError(result, nil); err != nil {
		return err
	}
	return nil
}

// AppendEntry appends a custom entry to the session for persistence.
func (c Context) AppendEntry(customType string, data any) error {
	result, err := c.callHost("appendEntry", map[string]any{
		"customType": customType,
		"data":       data,
	})
	if err != nil {
		return err
	}
	if err := callResultError(result, nil); err != nil {
		return err
	}
	return nil
}

// ── Editor Access ────────────────────────────────────────────────────────────

// GetEditorText returns the current text in the input editor. A host or transport failure is returned rather than replaced by empty text.
func (c Context) GetEditorText() (string, error) {
	return hostRequired[string](c, "ui.getEditorText", nil, "text")
}

// SetEditorText sets the text in the input editor.
func (c Context) SetEditorText(text string) {
	_, _ = c.callHost("ui.setEditorText", map[string]string{"text": text})
}

// PasteToEditor pastes text into the editor.
func (c Context) PasteToEditor(text string) {
	_, _ = c.callHost("ui.pasteToEditor", map[string]string{"text": text})
}

// ── Session State ────────────────────────────────────────────────────────────

// GetSessionName returns the current session name. Pi's getSessionName is `string | undefined`: nil means the session has no name, and a host or transport failure is returned as an error.
func (c Context) GetSessionName() (*string, error) {
	return hostOptionalString(c, "getSessionName", "name")
}

// SetSessionName sets the session name.
func (c Context) SetSessionName(name string) error {
	result, err := c.callHost("setSessionName", map[string]string{"name": name})
	if err != nil {
		return err
	}
	if err := callResultError(result, nil); err != nil {
		return err
	}
	return nil
}

// SetLabel sets or clears an entry label. The host's failure is returned, as
// upstream's setLabel throws when the session cannot record the label.
func (c Context) SetLabel(entryID, label string) error {
	result, err := c.callHost("setLabel", map[string]string{"entryId": entryID, "label": label})
	if err != nil {
		return err
	}
	if result != nil && result.Error != nil {
		return errors.New(result.Error.Message)
	}
	return nil
}

// GetFlag returns the host's flag value, or its first registered default when no override is set. False and empty strings are values, not missing overrides. A nil value with a nil error is Pi's undefined; a host or transport failure is returned rather than replaced by the default.
func (c Context) GetFlag(name string) (any, error) {
	value, present, err := hostOptional[any](c, "getFlag", map[string]string{"name": name}, "value")
	if err != nil {
		return nil, err
	}
	if !present {
		return c.ext.flagDefaults[name], nil
	}
	return value, nil
}

// GetThinkingLevel returns the current thinking level.
func (c Context) GetThinkingLevel() (string, error) {
	return hostRequired[string](c, "getThinkingLevel", nil, "level")
}

// SetThinkingLevel sets the thinking level.
func (c Context) SetThinkingLevel(level string) {
	_, _ = c.callHost("setThinkingLevel", map[string]string{"level": level})
}

// SetModel changes the active model.
func (c Context) SetModel(model string) (bool, error) {
	result, err := c.callHost("setModel", map[string]string{"model": model})
	if err != nil {
		return false, err
	}
	if result == nil {
		return false, nil
	}
	var resp struct {
		Success bool   `json:"success"`
		Error   string `json:"error,omitempty"`
	}
	_ = json.Unmarshal(result.Result, &resp)
	if resp.Error != "" {
		return false, fmt.Errorf("%s", resp.Error)
	}
	return resp.Success, nil
}

// ── Tool State ───────────────────────────────────────────────────────────────

// SourceInfo mirrors upstream SourceInfo: where a tool, command, prompt
// template or skill came from.
type SourceInfo struct {
	Path    string `json:"path"`
	Source  string `json:"source"`
	Scope   string `json:"scope"`
	Origin  string `json:"origin"`
	BaseDir string `json:"baseDir,omitempty"`
}

// ToolInfo mirrors upstream ToolInfo, one entry of GetAllTools: a tool
// definition's name, description, parameter schema and prompt guidelines,
// and the SourceInfo of what registered it ("builtin" for built-in tools).
type ToolInfo struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
	// PromptGuidelines is nil when the definition has none.
	PromptGuidelines []string   `json:"promptGuidelines,omitempty"`
	SourceInfo       SourceInfo `json:"sourceInfo"`
	// Exposure, Namespace and Annotations are the tool definition's fields; Exposure is never empty in upstream.
	// upstream: types.ts:2063 (ToolInfo)
	Exposure    ToolExposure     `json:"exposure,omitempty"`
	Namespace   *ToolNamespace   `json:"namespace,omitempty"`
	Annotations *ToolAnnotations `json:"annotations,omitempty"`
	// Source is PiG's per-tool source attribution: "builtin", the
	// registering extension's name, or the source a tool declares with
	// ToolWithSource.
	//
	// Deprecated: use SourceInfo.
	Source string `json:"source,omitempty"`
}

// GetActiveTools returns the currently active tool names.
func (c Context) GetActiveTools() ([]string, error) {
	return hostRequired[[]string](c, "getActiveTools", nil, "tools")
}

// GetAllTools returns every tool in the session's registry, active or not:
// built-in tools, then extension tools. Mirrors upstream pi.getAllTools().
func (c Context) GetAllTools() ([]ToolInfo, error) {
	return hostRequired[[]ToolInfo](c, "getAllTools", nil, "tools")
}

// SetActiveTools sets the active tool list.
func (c Context) SetActiveTools(tools []string) {
	_, _ = c.callHost("setActiveTools", map[string]any{"tools": tools})
}

// RefreshTools reloads tool definitions from the host.
func (c Context) RefreshTools() {
	_, _ = c.callHost("refreshTools", nil)
}

// ── Commands ─────────────────────────────────────────────────────────────────

// CommandInfo mirrors upstream SlashCommandInfo, one entry of GetCommands.
type CommandInfo struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// Source is "extension", "prompt" or "skill".
	Source     string     `json:"source"`
	SourceInfo SourceInfo `json:"sourceInfo"`
}

// GetCommands returns the session's extension commands, prompt templates and
// skills. Mirrors upstream pi.getCommands().
func (c Context) GetCommands() ([]CommandInfo, error) {
	return hostRequired[[]CommandInfo](c, "getCommands", nil, "commands")
}

// ── Context Usage ────────────────────────────────────────────────────────────

// ContextUsage reports context-window utilization. Tokens and Percent are nil while usage is unknown after compaction.
type ContextUsage struct {
	Tokens        *int     `json:"tokens"`
	ContextWindow int      `json:"contextWindow"`
	Percent       *float64 `json:"percent"`
}

// GetContextUsage returns context-window usage. Pi's getContextUsage is `ContextUsage | undefined`: nil means no usable model context window is available, and a host or transport failure is returned as an error.
func (c Context) GetContextUsage() (*ContextUsage, error) {
	return hostDecoded[*ContextUsage](c, "getContextUsage", nil)
}

// ── System Prompt ────────────────────────────────────────────────────────────

// GetSystemPrompt returns the current system prompt text.
func (c Context) GetSystemPrompt() (string, error) {
	return hostRequired[string](c, "getSystemPrompt", nil, "prompt")
}

// SystemPromptOptions holds the base inputs pi uses to build the system
// prompt. Same shape as before_agent_start event.systemPromptOptions.
// May include full context-file contents; treat as sensitive.
type SystemPromptOptions struct {
	CustomPrompt string `json:"customPrompt,omitempty"`
	// CustomPromptSet distinguishes an explicitly empty custom prompt from absence without changing CustomPrompt's string type.
	CustomPromptSet    bool                      `json:"-"`
	ForceSystemPrompt  *string                   `json:"forceSystemPrompt,omitempty"`
	SelectedTools      []string                  `json:"selectedTools,omitempty"`
	ToolSnippets       map[string]string         `json:"toolSnippets,omitempty"`
	ToolGuidelines     map[string][]string       `json:"toolGuidelines,omitempty"`
	PromptGuidelines   []string                  `json:"promptGuidelines,omitempty"`
	AppendSystemPrompt string                    `json:"appendSystemPrompt,omitempty"`
	Sections           *SystemPromptSections     `json:"sections,omitempty"`
	Cwd                string                    `json:"cwd"`
	ContextFiles       []SystemPromptContextFile `json:"contextFiles,omitempty"`
	Skills             []SystemPromptSkill       `json:"skills,omitempty"`
}

// SystemPromptContextFile is a pre-loaded context file (AGENTS.md, etc.).
type SystemPromptContextFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SystemPromptSkill is skill metadata surfaced in the prompt.
type SystemPromptSkill struct {
	Name                   string     `json:"name"`
	Description            string     `json:"description"`
	FilePath               string     `json:"filePath"`
	BaseDir                string     `json:"baseDir"`
	SourceInfo             SourceInfo `json:"sourceInfo"`
	DisableModelInvocation bool       `json:"disableModelInvocation"`
}

// GetSystemPromptOptions returns the base inputs pi currently uses to
// build the system prompt (custom prompt, active tools, tool snippets and guidelines,
// prompt guidelines, appended text, cwd, context files, complete skill metadata). It
// reports current base inputs only, not per-turn before_agent_start
// changes. Available in command handlers.
func (c Context) GetSystemPromptOptions() (SystemPromptOptions, error) {
	return hostDecoded[SystemPromptOptions](c, "getSystemPromptOptions", nil)
}

// ── Model Info ───────────────────────────────────────────────────────────────

// ModelInfo contains structured metadata about the active model.
type ModelInfo struct {
	InputLimits         map[string]any `json:"inputLimits,omitempty"`
	ID                  string         `json:"id"`
	Name                string         `json:"name"`
	Provider            string         `json:"provider"`
	ContextWindow       int            `json:"contextWindow"`
	MaxOutputTokens     int            `json:"maxOutputTokens"`
	Reasoning           bool           `json:"reasoning"`
	InputCostPer1M      float64        `json:"inputCostPer1M"`
	OutputCostPer1M     float64        `json:"outputCostPer1M"`
	CacheReadCostPer1M  float64        `json:"cacheReadCostPer1M"`
	CacheWriteCostPer1M float64        `json:"cacheWriteCostPer1M"`
}

func (m *ModelInfo) UnmarshalJSON(data []byte) error {
	var raw struct {
		InputLimits         map[string]any  `json:"inputLimits"`
		ID                  string          `json:"id"`
		ModelID             string          `json:"modelId"`
		Name                string          `json:"name"`
		DisplayName         string          `json:"displayName"`
		Provider            json.RawMessage `json:"provider"`
		ContextWindow       int             `json:"contextWindow"`
		MaxOutputTokens     int             `json:"maxOutputTokens"`
		MaxTokens           int             `json:"maxTokens"`
		Reasoning           bool            `json:"reasoning"`
		InputCostPer1M      float64         `json:"inputCostPer1M"`
		OutputCostPer1M     float64         `json:"outputCostPer1M"`
		CacheReadCostPer1M  float64         `json:"cacheReadCostPer1M"`
		CacheWriteCostPer1M float64         `json:"cacheWriteCostPer1M"`
		Cost                *struct {
			Input      float64 `json:"input"`
			Output     float64 `json:"output"`
			CacheRead  float64 `json:"cacheRead"`
			CacheWrite float64 `json:"cacheWrite"`
		} `json:"cost"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	m.InputLimits = raw.InputLimits
	m.ID = raw.ID
	if m.ID == "" {
		m.ID = raw.ModelID
	}
	m.Name = raw.Name
	if m.Name == "" {
		m.Name = raw.DisplayName
	}
	m.Provider = decodeModelProvider(raw.Provider)
	m.ContextWindow = raw.ContextWindow
	m.MaxOutputTokens = raw.MaxOutputTokens
	if m.MaxOutputTokens == 0 {
		m.MaxOutputTokens = raw.MaxTokens
	}
	m.Reasoning = raw.Reasoning
	m.InputCostPer1M = raw.InputCostPer1M
	m.OutputCostPer1M = raw.OutputCostPer1M
	m.CacheReadCostPer1M = raw.CacheReadCostPer1M
	m.CacheWriteCostPer1M = raw.CacheWriteCostPer1M
	if raw.Cost != nil {
		if m.InputCostPer1M == 0 {
			m.InputCostPer1M = raw.Cost.Input
		}
		if m.OutputCostPer1M == 0 {
			m.OutputCostPer1M = raw.Cost.Output
		}
		if m.CacheReadCostPer1M == 0 {
			m.CacheReadCostPer1M = raw.Cost.CacheRead
		}
		if m.CacheWriteCostPer1M == 0 {
			m.CacheWriteCostPer1M = raw.Cost.CacheWrite
		}
	}
	return nil
}

func decodeModelProvider(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var provider string
	if err := json.Unmarshal(raw, &provider); err == nil {
		return provider
	}
	var obj struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		return obj.ID
	}
	return ""
}

// GetModelInfo returns structured metadata about the active model. Pi's model is `Model | undefined`: nil means no model is set, and a host or transport failure is returned as an error.
func (c Context) GetModelInfo() (*ModelInfo, error) {
	info, err := hostDecoded[ModelInfo](c, "getModelInfo", nil)
	if err != nil || info.ID == "" {
		return nil, err
	}
	return &info, nil
}

// ── Session Branch ───────────────────────────────────────────────────────────

// BranchEntry represents a single entry in the session conversation history.
// The host sends entries in upstream's nested format:
//
//	{"type":"message","message":{"role":"assistant","content":[...],"usage":{...}}}
//
// UnmarshalJSON flattens the nested "message" object into the top-level struct
// so extension code can access entry.Role, entry.Usage, etc. directly.
type BranchEntry struct {
	ID               string         `json:"id,omitempty"`
	Type             string         `json:"type"`
	Role             string         `json:"role,omitempty"`
	Content          string         `json:"content,omitempty"`
	FirstKeptEntryID string         `json:"firstKeptEntryId,omitempty"`
	Thinking         string         `json:"thinking,omitempty"`
	Provider         string         `json:"provider,omitempty"`
	ModelID          string         `json:"model,omitempty"`
	ToolName         string         `json:"toolName,omitempty"`
	ToolCallID       string         `json:"toolCallId,omitempty"`
	IsError          bool           `json:"isError,omitempty"`
	Usage            *UsageInfo     `json:"usage,omitempty"`
	ToolCalls        []ToolCallInfo `json:"toolCalls,omitempty"`
}

// UnmarshalJSON handles the nested session entry format from the host.
// Entries arrive as {"type":"message","message":{...}} where the message
// object contains role, content, usage, etc. This method flattens the
// nested fields into the top-level BranchEntry.
func (b *BranchEntry) UnmarshalJSON(data []byte) error {
	// First pass: get the entry type and check for a nested "message" field.
	var raw struct {
		ID      string          `json:"id,omitempty"`
		Type    string          `json:"type"`
		Message json.RawMessage `json:"message,omitempty"`
		// Non-message entry fields (compaction, branch_summary, custom_message).
		Summary          string `json:"summary,omitempty"`
		Content          string `json:"content,omitempty"`
		FirstKeptEntryID string `json:"firstKeptEntryId,omitempty"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	b.ID = raw.ID
	b.Type = raw.Type
	b.FirstKeptEntryID = raw.FirstKeptEntryID

	if len(raw.Message) > 0 && raw.Message[0] == '{' {
		// Nested message entry: flatten its fields into BranchEntry.
		var msg struct {
			Role       string          `json:"role"`
			Content    json.RawMessage `json:"content"`
			Provider   string          `json:"provider,omitempty"`
			Model      string          `json:"model,omitempty"`
			ToolName   string          `json:"toolName,omitempty"`
			ToolCallID string          `json:"toolCallId,omitempty"`
			IsError    bool            `json:"isError,omitempty"`
			Usage      *UsageInfo      `json:"usage,omitempty"`
		}
		if err := json.Unmarshal(raw.Message, &msg); err != nil {
			return nil // graceful: leave fields empty on decode failure
		}
		b.Role = msg.Role
		b.Provider = msg.Provider
		b.ModelID = msg.Model
		b.ToolName = msg.ToolName
		b.ToolCallID = msg.ToolCallID
		b.IsError = msg.IsError
		b.Usage = msg.Usage

		// Content can be a string or an array of content blocks.
		if len(msg.Content) > 0 {
			switch msg.Content[0] {
			case '"':
				// Plain string content.
				_ = json.Unmarshal(msg.Content, &b.Content)
			case '[':
				// Array of content blocks: extract text, thinking, and tool calls.
				var blocks []struct {
					Type      string `json:"type"`
					Text      string `json:"text,omitempty"`
					Thinking  string `json:"thinking,omitempty"`
					Name      string `json:"name,omitempty"`
					ID        string `json:"id,omitempty"`
					Arguments string `json:"arguments,omitempty"`
					Input     any    `json:"input,omitempty"`
				}
				if json.Unmarshal(msg.Content, &blocks) == nil {
					var textParts []string
					for _, block := range blocks {
						switch block.Type {
						case "text":
							textParts = append(textParts, block.Text)
						case "thinking":
							b.Thinking += block.Thinking
						case "tool_use", "toolCall":
							args := block.Arguments
							if args == "" && block.Input != nil {
								if a, err := json.Marshal(block.Input); err == nil {
									args = string(a)
								}
							}
							b.ToolCalls = append(b.ToolCalls, ToolCallInfo{
								Name: block.Name,
								ID:   block.ID,
								Args: args,
							})
						case "tool_result":
							// tool results in user messages; extract text
							textParts = append(textParts, block.Text)
						}
					}
					b.Content = strings.Join(textParts, "")
				}
			}
		}
	} else {
		// Non-message entries (compaction, branch_summary, custom_message).
		b.Content = raw.Content
		if b.Content == "" {
			b.Content = raw.Summary
		}
	}
	return nil
}

// UsageInfo contains token usage data for an assistant message.
type UsageInfo struct {
	Input       int `json:"input"`
	Output      int `json:"output"`
	CacheRead   int `json:"cacheRead"`
	CacheWrite  int `json:"cacheWrite"`
	TotalTokens int `json:"totalTokens"`
}

// ToolCallInfo describes a tool invocation in an assistant message.
type ToolCallInfo struct {
	Name string `json:"name"`
	ID   string `json:"id"`
	Args string `json:"args"`
}

// GetBranch returns the conversation branch as []BranchEntry.
// The slice and its entry values are copies.
// Nested fields are shared with the decoded mirror and must be treated as read-only.
// GetBranch returns nil without a session.
func (c Context) GetBranch() ([]BranchEntry, error) {
	if c.replacement != nil {
		raw, err := sessionValue[[]json.RawMessage](c.SessionManager(), "getBranch", map[string]any{"fromId": nil})
		if err != nil || len(raw) == 0 {
			return nil, err
		}
		branch := make([]BranchEntry, 0, len(raw))
		for _, entry := range raw {
			var decoded BranchEntry
			if json.Unmarshal(entry, &decoded) == nil {
				branch = append(branch, decoded)
			}
		}
		return branch, nil
	}
	if err := c.ext.ensureSessionLog(); err != nil {
		return nil, err
	}
	entries := c.ext.session.getBranchEntries()
	if len(entries) == 0 {
		return nil, nil
	}
	branch := make([]BranchEntry, len(entries))
	for i, entry := range entries {
		if entry != nil {
			branch[i] = *entry
		}
	}
	return branch, nil
}

// ── Session state ───────────────────────────────────────────────────────────

// GetEntries returns all session entries.
func (c Context) GetEntries() ([]json.RawMessage, error) {
	if c.replacement != nil {
		return sessionValue[[]json.RawMessage](c.SessionManager(), "getEntries", nil)
	}
	if err := c.ext.ensureSessionLog(); err != nil {
		return nil, err
	}
	return c.ext.session.getEntries(), nil
}

// GetSessionID returns the current session ID, including for in-memory sessions.
func (c Context) GetSessionID() (string, error) {
	return hostRequired[string](c, "getSessionID", nil, "sessionId")
}

// GetSessionFile returns the current session file path. Pi's getSessionFile is `string | undefined`: nil means an in-memory session.
func (c Context) GetSessionFile() (*string, error) {
	return hostOptionalString(c, "getSessionFile", "sessionFile")
}

// GetLeafID returns the current leaf entry ID. Pi's getLeafId is `string | null`: nil means an empty session.
func (c Context) GetLeafID() (*string, error) {
	return hostOptionalString(c, "getLeafID", "leafId")
}

// ── Provider ─────────────────────────────────────────────────────────────────

// GetModelAuth returns auth credentials for a specific provider+model. A host or transport failure is returned as an error.
func (c Context) GetModelAuth(providerID, modelID string) (json.RawMessage, error) {
	result, err := c.callHost("getModelAuth", map[string]string{
		"provider": providerID,
		"modelId":  modelID,
	})
	if err := callResultError(result, err); err != nil {
		return nil, err
	}
	if result == nil {
		return nil, errors.New("host returned no result")
	}
	return result.Result, nil
}

// ModelEventStream is the SDK-side pull stream for host model operations.
type ModelEventStream struct {
	mu        sync.Mutex
	delivery  sync.Mutex
	queue     []map[string]any
	changed   chan struct{}
	done      chan struct{}
	terminal  bool
	result    map[string]any
	startOnce sync.Once
	started   chan error
}

// End completes iteration and resolves the final provider result.
func (s *ModelEventStream) End(result map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.terminal {
		return
	}
	s.terminal = true
	s.result = result
	close(s.done)
	close(s.changed)
	s.changed = make(chan struct{})
}

func newModelEventStream() *ModelEventStream {
	return &ModelEventStream{changed: make(chan struct{}), done: make(chan struct{}), started: make(chan error, 1)}
}

func (s *ModelEventStream) markStarted(err error) {
	s.startOnce.Do(func() { s.started <- err; close(s.started) })
}

func (s *ModelEventStream) push(event map[string]any) {
	s.mu.Lock()
	if s.terminal {
		s.mu.Unlock()
		return
	}
	s.queue = append(s.queue, event)
	if eventType, _ := event["type"].(string); eventType == "done" || eventType == "error" {
		s.terminal = true
		if eventType == "done" {
			s.result, _ = event["message"].(map[string]any)
		} else {
			s.result, _ = event["error"].(map[string]any)
		}
		close(s.done)
	}
	close(s.changed)
	s.changed = make(chan struct{})
	s.mu.Unlock()
}

// Events returns model events in host order until terminal or cancellation.
func (s *ModelEventStream) Events(ctx context.Context) <-chan map[string]any {
	out := make(chan map[string]any)
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			s.delivery.Lock()
			s.mu.Lock()
			if len(s.queue) > 0 {
				event := s.queue[0]
				s.mu.Unlock()
				select {
				case out <- event:
					s.mu.Lock()
					s.queue[0] = nil
					s.queue = s.queue[1:]
					if len(s.queue) == 0 {
						s.queue = nil
					}
					s.mu.Unlock()
					s.delivery.Unlock()
				case <-ctx.Done():
					s.delivery.Unlock()
					return
				}
				continue
			}
			if s.terminal {
				s.mu.Unlock()
				s.delivery.Unlock()
				return
			}
			changed := s.changed
			s.mu.Unlock()
			s.delivery.Unlock()
			select {
			case <-changed:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// Result waits for and returns the decoded terminal assistant message.
func (s *ModelEventStream) Result() map[string]any {
	<-s.done
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.result
}

func modelStreamErrorEvent(err error, model map[string]any) map[string]any {
	provider, _ := model["provider"].(string)
	if provider == "" {
		if value, ok := model["provider"].(map[string]any); ok {
			provider, _ = value["id"].(string)
		}
	}
	modelID, _ := model["modelId"].(string)
	if modelID == "" {
		modelID, _ = model["id"].(string)
	}
	api, _ := model["api"].(string)
	return map[string]any{
		"type": "error", "reason": "error",
		"error": map[string]any{
			"role": "assistant", "content": []any{}, "api": api,
			"provider": provider, "model": modelID,
			"usage": map[string]any{
				"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
				"cost": map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
			},
			"stopReason": "error", "errorMessage": err.Error(), "timestamp": time.Now().UnixMilli(),
		},
	}
}

// ModelRegistry exposes Session model discovery, request authentication, and
// model operations through the host-owned runtime.
type ModelRegistry struct{ context Context }

// ModelRegistry returns the current Session model registry facade.
func (c Context) ModelRegistry() ModelRegistry { return ModelRegistry{context: c} }

// Find resolves a model by exact provider and model ID through the host registry.
func (r ModelRegistry) Find(providerID, modelID string) map[string]any {
	result, err := r.context.callHost("getModel", map[string]string{"provider": providerID, "modelId": modelID})
	if err := callResultError(result, err); err != nil || result == nil || string(result.Result) == "null" {
		return nil
	}
	var model map[string]any
	if err := json.Unmarshal(result.Result, &model); err != nil {
		return nil
	}
	return model
}

// GetApiKeyAndHeaders resolves request authentication through the host.
func (r ModelRegistry) GetApiKeyAndHeaders(model map[string]any) (map[string]any, error) {
	provider, _ := model["provider"].(string)
	if provider == "" {
		if value, ok := model["provider"].(map[string]any); ok {
			provider, _ = value["id"].(string)
		}
	}
	modelID, _ := model["modelId"].(string)
	if modelID == "" {
		modelID, _ = model["id"].(string)
	}
	result, err := r.context.callHost("getModelAuth", map[string]string{"provider": provider, "modelId": modelID})
	if err := callResultError(result, err); err != nil {
		return nil, err
	}
	if result == nil {
		return nil, nil
	}
	var auth map[string]any
	if err := json.Unmarshal(result.Result, &auth); err != nil {
		return nil, err
	}
	return auth, nil
}

func (r ModelRegistry) Stream(model, request, options map[string]any) *ModelEventStream {
	return r.stream(model, request, options, false)
}

func (r ModelRegistry) stream(model, request, options map[string]any, simple bool) *ModelEventStream {
	stream := newModelEventStream()
	streamID := fmt.Sprintf("model-stream-%d", r.context.ext.modelStreamSeq.Add(1))
	r.context.ext.modelStreamsMu.Lock()
	r.context.ext.modelStreams[streamID] = stream
	r.context.ext.modelStreamsMu.Unlock()
	merged := make(map[string]any, len(request)+len(options))
	for key, value := range request {
		merged[key] = value
	}
	for key, value := range options {
		merged[key] = value
	}
	go func() {
		result, err := r.context.callHost("modelStream", map[string]any{"streamId": streamID, "model": model, "request": merged, "simple": simple})
		if err := callResultError(result, err); err != nil {
			stream.push(modelStreamErrorEvent(err, model))
		} else {
			// The host sends every model_stream_event before its call result, but
			// the main loop applies notifications after the read loop routes the
			// result here. Unregister only after those notifications are applied.
			ext := r.context.ext
			ext.waitNotifications(ext.conn.notifications.Load(), stream.done)
			stream.push(modelStreamErrorEvent(errors.New("model stream ended without a terminal event"), model))
		}
		r.context.ext.modelStreamsMu.Lock()
		delete(r.context.ext.modelStreams, streamID)
		r.context.ext.modelStreamsMu.Unlock()
	}()
	return stream
}

func (r ModelRegistry) StreamSimple(model, request, options map[string]any) *ModelEventStream {
	return r.stream(model, request, options, true)
}

func (r ModelRegistry) Complete(model, request, options map[string]any) map[string]any {
	return r.Stream(model, request, options).Result()
}

// Complete performs an LLM completion using the host's provider infrastructure.
func (c Context) Complete(model, request, auth map[string]any) (json.RawMessage, error) {
	result, err := c.callHost("complete", map[string]any{
		"model":   model,
		"request": request,
		"auth":    auth,
	})
	if err != nil {
		return nil, err
	}
	if err := callResultError(result, nil); err != nil {
		return nil, err
	}
	if result == nil {
		return nil, nil
	}
	return result.Result, nil
}

// ── Shell ─────────────────────────────────────────────────────────────────────

// ExecResult contains the result of a shell command execution.
type ExecResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"code"`
	// Killed reports that the command was killed by its timeout or by
	// cancellation.
	Killed bool `json:"killed"`
}

// ExecOptions mirrors the serializable part of upstream ExecOptions. The
// command's AbortSignal is the request's cancellation.
type ExecOptions struct {
	// Timeout kills the command after this many milliseconds. Pi's timeout is
	// a JavaScript number, so fractional and very large values are preserved.
	// Only a positive value starts a timer; zero is omitted.
	Timeout float64 `json:"timeout,omitempty"`
	// Cwd is the command's working directory. Empty uses the session's.
	Cwd string `json:"cwd,omitempty"`
}

// Exec runs a shell command through the host's bash executor.
func (c Context) Exec(command string, args []string) (*ExecResult, error) {
	return c.exec(map[string]any{"command": command, "args": args})
}

// ExecWithOptions is [Context.Exec] with upstream's exec options.
func (c Context) ExecWithOptions(command string, args []string, opts ExecOptions) (*ExecResult, error) {
	return c.exec(map[string]any{"command": command, "args": args, "options": opts})
}

func (c Context) exec(payload map[string]any) (*ExecResult, error) {
	result, err := c.callHost("exec", payload)
	if err != nil {
		return nil, err
	}
	if err := callResultError(result, nil); err != nil {
		return nil, err
	}
	if result == nil {
		return nil, nil
	}
	var exec ExecResult
	_ = json.Unmarshal(result.Result, &exec)
	return &exec, nil
}

// ── Theme ────────────────────────────────────────────────────────────────────

// GetAllThemes returns all available themes with their names and paths. A host or transport failure is returned rather than an empty list.
func (c Context) GetAllThemes() ([]ThemeMeta, error) {
	return hostRequired[[]ThemeMeta](c, "ui.getAllThemes", nil, "themes")
}

// GetTheme loads a theme by name without switching to it.
func (c Context) GetTheme(name string) (Theme, error) {
	result, err := c.callHost("ui.getTheme", map[string]string{"name": name})
	if err := callResultError(result, err); err != nil {
		return nil, err
	}
	var resp struct {
		Theme Theme `json:"theme"`
	}
	if result == nil {
		return nil, nil
	}
	if err := json.Unmarshal(result.Result, &resp); err != nil {
		return nil, err
	}
	return resp.Theme, nil
}

// SetTheme switches the current theme by name.
func (c Context) SetTheme(name string) (bool, string) {
	result, err := c.callHost("ui.setTheme", map[string]string{"theme": name})
	if err != nil || result == nil {
		return false, err.Error()
	}
	var resp struct {
		Success bool   `json:"success"`
		Error   string `json:"error,omitempty"`
	}
	_ = json.Unmarshal(result.Result, &resp)
	return resp.Success, resp.Error
}

// ── Widgets & advanced UI ───────────────────────────────────────────────────

// SetWidget sets or clears a widget. A []string is content the host lays out as
// Pi does for ctx.ui.setWidget(key, string[]): each entry becomes Text(line, 1,
// 0) at the host's width, the first ten entries are shown, and a muted
// "... (widget truncated)" row follows a longer list (interactive-mode.ts:2321-2336).
// A row wider than the pane wraps; it never reaches the renderer over-wide.
//
// A non-nil []string with no options goes out as a widget_push frame without a
// width, which the host applies in arrival order and never answers: Pi's
// setWidget returns void, so it may be called from an [Context.OnWidthChange]
// handler, and the error reports only a failure to send. Every other shape
// waits for the host.
func (c Context) SetWidget(key string, content any, options ...WidgetOptions) error {
	if lines, ok := content.([]string); ok && lines != nil && len(options) == 0 {
		return c.ext.conn.pushWidget(key, lines)
	}
	var opts WidgetOptions
	if len(options) > 0 {
		opts = options[0]
	}
	result, err := c.callHost("ui.setWidget", map[string]any{
		"key":     key,
		"content": content,
		"options": opts,
	})
	return callResultError(result, err)
}

// SetFooter replaces the default footer with pre-rendered lines when lines
// is a non-empty []string, or clears a previously set footer when lines is nil.
// Component factories (non-string values) cannot be serialized across the
// subprocess boundary; use [Context.SetFooterRenderer] for a footer laid out at
// the host's width.
//
// Pi renders a footer component at the current width every frame, so it never
// paints rows laid out for another width. The rows sent here carry the width
// the SDK holds when they are sent, and the host paints them only at that
// width: after a resize they stay hidden until the extension sends rows for the
// new width (see [Context.OnWidthChange]). Rows that were laid out for an
// earlier Context.Width than the one current at this call are tagged with the
// later width; a footer that must never be wrong renders through
// SetFooterRenderer. Setting rows replaces any footer renderer.
func (c Context) SetFooter(lines []string) error {
	return c.setSurface(footerMethod, lines)
}

// SetLogin replaces the shared header with a login rendered by the host.
// The host validates the definition and remains authoritative for rendering.
func (c Context) SetLogin(definition LoginDefinition) error {
	result, err := c.ext.conn.call("ui.setLogin", definition)
	return callResultError(result, err)
}

// RegisterSprite adds a sprite to /sprite, where the user can choose and save
// it. The host validates the definition; registering the same ID again replaces
// this extension's sprite, and the sprite leaves /sprite when the extension
// unloads.
func (c Context) RegisterSprite(definition SpriteDefinition) error {
	result, err := c.ext.conn.call("ui.registerSprite", definition)
	return callResultError(result, err)
}

// SetHeader replaces the default header with pre-rendered lines when lines
// is a non-empty []string, or clears a previously set header when lines is nil.
// Component factories (non-string values) cannot be serialized across the
// subprocess boundary; use [Context.SetHeaderRenderer] for a header laid out at
// the host's width. The rows carry the width the SDK holds when they are sent,
// as described at [Context.SetFooter].
func (c Context) SetHeader(lines []string) error {
	return c.setSurface(headerMethod, lines)
}

// Custom opens a focused remote component. Pass a [RemoteComponent] as factory
// and [RemoteOverlayOptions] (or an equivalent JSON object) as options. Other
// factory values retain the explicit unsupported error because live host TUI
// component objects cannot cross a subprocess boundary. With no UI, Custom returns nil without invoking component callbacks.
func (c Context) Custom(factory any, options any) (any, error) {
	if !c.HasUI() {
		return nil, nil
	}
	c.reportRequestState("blocked", "user")
	component, ok := factory.(RemoteComponent)
	if !ok || component == nil {
		result, err := c.callHost("ui.custom", map[string]any{})
		if err := callResultError(result, err); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("%w: custom component must implement sdk.RemoteComponent", ErrUnsupportedSubprocessUI)
	}
	return c.runRemoteComponent(component, options)
}

func (c Context) runRemoteComponent(component RemoteComponent, options any) (_ any, returnErr error) {
	key := fmt.Sprintf("custom-%d", c.ext.overlaySeq.Add(1))
	overlay := newRemoteOverlay(component)
	c.ext.overlaysMu.Lock()
	c.ext.overlays[key] = overlay
	c.ext.overlaysMu.Unlock()
	defer func() {
		stopped := overlay.stop()
		c.ext.overlaysMu.Lock()
		delete(c.ext.overlays, key)
		c.ext.overlaysMu.Unlock()
		if !stopped {
			if returnErr == nil {
				returnErr = errors.New("focused component did not stop before the cleanup deadline")
			}
			return
		}
		if disposer, ok := component.(RemoteComponentDisposer); ok {
			// Upstream resolves the custom call before cleanup and ignores a
			// disposer panic. Keep one bad component from killing its extension.
			func() {
				defer func() { _ = recover() }()
				disposer.Dispose()
			}()
		}
	}()

	args := map[string]any{"key": key}
	if options != nil {
		encoded, err := json.Marshal(options)
		if err != nil {
			return nil, fmt.Errorf("encode custom overlay options: %w", err)
		}
		if err := json.Unmarshal(encoded, &args); err != nil {
			return nil, fmt.Errorf("custom overlay options must be an object: %w", err)
		}
		args["key"] = key
	}
	// Arm input and invalidation before the host sees the open call. A fused
	// transport can focus the overlay and return the first key while beginCallFor
	// is still sending the request.
	if err := overlay.start(c.hostConnection(), key, c.Width); err != nil {
		return nil, err
	}
	pending, err := c.beginHostCall("ui.custom", args)
	if err != nil {
		return nil, err
	}
	if err := overlay.render(c.hostConnection(), key, c.Width()); err != nil {
		_ = c.hostConnection().notify("ui.custom.close", map[string]any{"key": key})
		_, _ = c.hostConnection().waitCall(pending)
		return nil, err
	}
	result, err := c.hostConnection().waitCall(pending)
	c.reportRequestState("progress", "")
	if err := callResultError(result, err); err != nil {
		return nil, err
	}
	if result == nil || len(result.Result) == 0 || string(result.Result) == "null" {
		return nil, nil
	}
	var response struct {
		Result any  `json:"result"`
		Ok     bool `json:"ok"`
	}
	if err := json.Unmarshal(result.Result, &response); err != nil {
		return nil, err
	}
	if !response.Ok {
		return nil, nil
	}
	return response.Result, nil
}

// OnTerminalInput subscribes to raw terminal input, receiving every chunk
// before the editor does. The host is told to start forwarding only on the
// first subscription and to stop on the last, so an extension that never
// subscribes costs the input loop nothing.
//
// The returned unsubscribe is idempotent. With no UI, no subscription is retained.
func (c Context) OnTerminalInput(handler TerminalInputHandler) (func(), error) {
	if !c.HasUI() {
		return func() {}, nil
	}
	if handler == nil {
		return func() {}, fmt.Errorf("OnTerminalInput: handler must not be nil")
	}
	e := c.ext

	e.terminalInputMu.Lock()
	e.terminalInputNextID++
	id := e.terminalInputNextID
	e.terminalInputFuncs = append(e.terminalInputFuncs, terminalInputSub{id: id, handler: handler})
	first := len(e.terminalInputFuncs) == 1
	e.terminalInputMu.Unlock()

	unsubscribe := sync.OnceFunc(func() {
		e.terminalInputMu.Lock()
		e.terminalInputFuncs = slices.DeleteFunc(e.terminalInputFuncs, func(s terminalInputSub) bool {
			return s.id == id
		})
		last := len(e.terminalInputFuncs) == 0
		e.terminalInputMu.Unlock()
		if last {
			_, _ = e.conn.call("ui.offTerminalInput", map[string]any{})
		}
	})

	if !first {
		return unsubscribe, nil
	}
	result, err := e.conn.call("ui.onTerminalInput", map[string]any{})
	if err := callResultError(result, err); err != nil {
		unsubscribe()
		return func() {}, err
	}
	return unsubscribe, nil
}

// SetEditorComponent clears the custom editor when factory is nil. With no UI, it ignores the factory.
func (c Context) SetEditorComponent(factory any) error {
	if !c.HasUI() {
		return nil
	}
	if factory != nil {
		return fmt.Errorf("%w: editor component factories cannot be serialized", ErrUnsupportedSubprocessUI)
	}
	result, err := c.callHost("ui.setEditorComponent", map[string]any{"clear": true})
	return callResultError(result, err)
}

// GetEditorComponent is unsupported for subprocess extensions because the
// host-side editor component factory cannot be serialized back over RPC.
func (c Context) GetEditorComponent() any {
	return nil
}

// ── Tool expansion ───────────────────────────────────────────────────────────

// GetToolsExpanded returns whether tool outputs are expanded.
func (c Context) GetToolsExpanded() (bool, error) {
	return hostRequired[bool](c, "ui.getToolsExpanded", nil, "expanded")
}

// SetToolsExpanded sets whether tool outputs are expanded.
func (c Context) SetToolsExpanded(expanded bool) {
	_, _ = c.callHost("ui.setToolsExpanded", map[string]any{"expanded": expanded})
}

// ── Local state (cached from ready message) ──────────────────────────────────

// ConfigHome returns the pig config root directory.
// Reads PIG_HOME env var, defaulting to ~/.pig.
func (c Context) ConfigHome() string {
	if h := os.Getenv("PIG_HOME"); h != "" {
		return h
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pig")
}

// Cwd returns the working directory (from the ready message).
func (c Context) Cwd() string {
	if c.replacement != nil {
		return c.replacement.cwd
	}
	c.ext.mu.RLock()
	defer c.ext.mu.RUnlock()
	return c.ext.cwd
}

// Mode returns the run mode pi is operating in: "tui", "rpc", "json", or
// "print" (from the ready message). Guard terminal-only UI on "tui".
// Defaults to "print" when the host did not specify one.
func (c Context) Mode() string {
	if c.replacement != nil && c.replacement.mode != "" {
		return c.replacement.mode
	}
	c.ext.mu.RLock()
	defer c.ext.mu.RUnlock()
	if c.ext.mode == "" {
		return "print"
	}
	return c.ext.mode
}

// HasUI reports whether the host has bound a UI context. Print and JSON modes have no UI; interactive and RPC modes do.
func (c Context) HasUI() bool {
	if c.replacement != nil {
		return c.replacement.hasUI
	}
	c.ext.mu.RLock()
	defer c.ext.mu.RUnlock()
	return c.ext.hasUI
}

// Width returns the terminal width (from the ready message).
func (c Context) Width() int {
	c.ext.mu.RLock()
	defer c.ext.mu.RUnlock()
	return c.ext.width
}

// Height returns the current terminal height in rows. Updated by height_change
// notifications from the host. Returns 0 if the host has not reported a height.
func (c Context) Height() int {
	c.ext.mu.RLock()
	defer c.ext.mu.RUnlock()
	return c.ext.height
}

// Model returns the active provider model ID when the host exposes one, falling
// back to the model name from the ready/state message.
func (c Context) Model() string {
	if c.replacement != nil {
		id, _ := c.replacementModel()
		return id
	}
	c.ext.mu.RLock()
	defer c.ext.mu.RUnlock()
	return c.ext.model
}

// ModelProvider returns the active model's provider ID (e.g. "github-copilot",
// "anthropic"). Returns "" if unknown. Use with Model() to build a
// provider-qualified model string: provider + "/" + model.
func (c Context) ModelProvider() string {
	if c.replacement != nil {
		_, provider := c.replacementModel()
		return provider
	}
	c.ext.mu.RLock()
	defer c.ext.mu.RUnlock()
	return c.ext.modelProvider
}

// ModelQualified returns the provider-qualified model string
// ("provider/model"). If the provider is unknown, returns just the model name.
func (c Context) ModelQualified() string {
	if c.replacement != nil {
		id, provider := c.replacementModel()
		if provider != "" {
			return provider + "/" + id
		}
		return id
	}
	c.ext.mu.RLock()
	defer c.ext.mu.RUnlock()
	if c.ext.modelProvider != "" {
		return c.ext.modelProvider + "/" + c.ext.model
	}
	return c.ext.model
}

// ToolCallID returns the current tool call ID (only valid inside tool handlers).
func (c Context) ToolCallID() string {
	return c.toolCallID
}

// OnUpdate streams a partial result of the running tool, as upstream's
// execute(toolCallId, params, signal, onUpdate) callback does. partial is a
// string or a ToolResult (or any value with its wire shape). The host shows
// updates in order, before the tool's final result.
func (c Context) OnUpdate(partial any) error {
	if c.toolCallID == "" || c.requestID == "" {
		return errors.New("OnUpdate is only available while a tool runs")
	}
	if text, ok := partial.(string); ok {
		partial = ToolResult{Content: text}
	}
	return c.ext.conn.notify("tool_update", map[string]any{"request_id": c.requestID, "result": partial})
}

// ═══════════════════════════════════════════════════════════════════════════════
// Agent control
// ═══════════════════════════════════════════════════════════════════════════════

// IsProjectTrusted reports whether the current project is trusted. Untrusted
// projects have project-scoped settings and hooks disabled. A host or transport failure is returned rather than assumed trusted.
func (c Context) IsProjectTrusted() (bool, error) {
	return hostRequired[bool](c, "isProjectTrusted", nil, "trusted")
}

// IsIdle returns whether the agent is currently idle (not streaming). A host or transport failure is returned rather than assumed idle.
func (c Context) IsIdle() (bool, error) {
	return hostRequired[bool](c, "isIdle", nil, "idle")
}

// Abort cancels the current agent operation.
func (c Context) Abort() {
	_, _ = c.callHost("abort", nil)
}

// HasPendingMessages returns whether there are queued messages waiting.
func (c Context) HasPendingMessages() (bool, error) {
	return hostRequired[bool](c, "hasPendingMessages", nil, "pending")
}

// Shutdown triggers a graceful agent shutdown and exit.
func (c Context) Shutdown() {
	_, _ = c.callHost("shutdown", nil)
}

// Compact triggers compaction. Options are optional.
func (c Context) Compact(opts map[string]any) {
	_, _ = c.callHost("compact", opts)
}

// CompactOptions mirrors upstream CompactOptions.
type CompactOptions struct {
	// CustomInstructions steer the compaction summary.
	CustomInstructions string
	// OnComplete receives upstream's CompactionResult when compaction
	// finishes.
	OnComplete func(result map[string]any)
	// OnError receives the failure when compaction fails.
	OnError func(err error)
}

// CompactWithOptions starts compaction without waiting for it, as upstream
// ctx.compact does. With OnComplete or OnError set, it reports the outcome to
// them from another goroutine once compaction finishes; the call outlives the
// handler that started it.
func (c Context) CompactWithOptions(opts CompactOptions) {
	args := map[string]any{}
	if opts.CustomInstructions != "" {
		args["customInstructions"] = opts.CustomInstructions
	}
	if opts.OnComplete == nil && opts.OnError == nil {
		c.Compact(args)
		return
	}
	if c.ext == nil || c.ext.conn == nil {
		return
	}
	args["awaitCompletion"] = true
	conn := c.ext.conn
	go func() {
		// The callbacks run after their handler returned; a panicking one
		// must not take the extension down with it.
		defer func() {
			if recovered := recover(); recovered != nil {
				fmt.Fprintf(os.Stderr, "extension: recovered from panic in compact callback: %v\n%s\n", recovered, debug.Stack())
			}
		}()
		result, err := conn.call("compact", args)
		if err := callResultError(result, err); err != nil {
			if opts.OnError != nil {
				opts.OnError(err)
			}
			return
		}
		var compaction map[string]any
		if result != nil && len(result.Result) > 0 {
			if err := json.Unmarshal(result.Result, &compaction); err != nil {
				if opts.OnError != nil {
					opts.OnError(fmt.Errorf("decode compaction result: %w", err))
				}
				return
			}
		}
		if opts.OnComplete != nil {
			opts.OnComplete(compaction)
		}
	}()
}

// ═══════════════════════════════════════════════════════════════════════════════
// Command-only session control
// ═══════════════════════════════════════════════════════════════════════════════

// CancelledResult mirrors upstream's `{ cancelled: boolean }` return type.
type CancelledResult struct {
	Cancelled bool `json:"cancelled"`
}

func decodeCancelledResult(result *callResultMsg) CancelledResult {
	if result == nil || len(result.Result) == 0 {
		return CancelledResult{}
	}
	var r CancelledResult
	_ = json.Unmarshal(result.Result, &r)
	return r
}

// WaitForIdle blocks until the agent finishes streaming. Command-only.
func (c Context) WaitForIdle() error {
	result, err := c.callHost("waitForIdle", nil)
	return callResultError(result, err)
}

// NewSession starts a new session. opts may hold "parentSession" and a "withSession" WithSessionFunc.
func (c Context) NewSession(opts map[string]any) (CancelledResult, error) {
	return c.callReplacement("newSession", opts)
}

// Fork creates a new branch from an entry. opts may hold "position" and a "withSession" WithSessionFunc.
func (c Context) Fork(entryID string, opts map[string]any) (CancelledResult, error) {
	args := map[string]any{"entryId": entryID}
	for k, v := range opts {
		args[k] = v
	}
	return c.callReplacement("fork", args)
}

// NavigateTree moves to a different point in the session tree.
func (c Context) NavigateTree(targetID string, opts map[string]any) (CancelledResult, error) {
	args := map[string]any{"targetId": targetID}
	for k, v := range opts {
		args[k] = v
	}
	result, err := c.callHost("navigateTree", args)
	if err := callResultError(result, err); err != nil {
		return CancelledResult{}, err
	}
	return decodeCancelledResult(result), nil
}

// SwitchSession switches to a different session file. opts may hold a "withSession" WithSessionFunc.
func (c Context) SwitchSession(sessionPath string, opts map[string]any) (CancelledResult, error) {
	args := map[string]any{"sessionPath": sessionPath}
	for k, v := range opts {
		args[k] = v
	}
	return c.callReplacement("switchSession", args)
}

// Reload reloads extensions, skills, prompts, and themes.
func (c Context) Reload() error {
	result, err := c.callHost("reload", nil)
	return callResultError(result, err)
}

// OnWidthChange subscribes to terminal resizes, receiving the new width after
// Context.Width has been updated.
//
// Upstream Pi installs headers and footers as component factories whose
// render(width) runs every frame, so they follow a resize with no work from the
// extension. Rows sent with [Context.SetFooter] or [Context.SetHeader] are
// painted only at the width they carry, so after a resize they stay hidden until
// the extension sends rows for the new width; this is that trigger.
// [Context.SetFooterRenderer] and [Context.SetHeaderRenderer] follow a resize
// with no handler.
//
// Handlers run on their own goroutine, one at a time in the order the host
// sent the widths, never on the message loop or the goroutine that reads the
// host's replies, so a handler can make a blocking host call such as
// SetFooter. A slow handler delays the later deliveries, not the extension's
// other handlers. A handler that panics is recovered and does not stop the
// others. Context.Width in a handler is that width or a newer one. The
// returned unsubscribe is idempotent; a delivery already queued still reaches
// the handlers that were subscribed when the width arrived.
func (c Context) OnWidthChange(handler WidthChangeHandler) (func(), error) {
	if handler == nil {
		return func() {}, fmt.Errorf("OnWidthChange: handler must not be nil")
	}
	e := c.ext

	e.widthChangeMu.Lock()
	e.widthChangeNextID++
	id := e.widthChangeNextID
	e.widthChangeFuncs = append(e.widthChangeFuncs, widthChangeSub{id: id, handler: handler})
	e.widthChangeMu.Unlock()

	return sync.OnceFunc(func() {
		e.widthChangeMu.Lock()
		e.widthChangeFuncs = slices.DeleteFunc(e.widthChangeFuncs, func(s widthChangeSub) bool {
			return s.id == id
		})
		e.widthChangeMu.Unlock()
	}), nil
}
