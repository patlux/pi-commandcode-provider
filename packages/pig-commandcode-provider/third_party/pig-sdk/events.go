// SPDX-FileCopyrightText: Copyright Hewlett Packard Enterprise Development LP
// SPDX-License-Identifier: MIT

package sdk

// Event names accepted by [Extension.OnEvent]. Each is the name of one
// upstream pi.on overload (ExtensionAPI.on in Pi's extensions/types.ts), and
// the handler's data map is that event's payload.
const (
	// Startup and resources.
	EventProjectTrust       = "project_trust"
	EventResourcesDiscover  = "resources_discover"
	EventSessionStart       = "session_start"
	EventSessionInfoChanged = "session_info_changed"

	// Session lifecycle.
	EventSessionBeforeSwitch  = "session_before_switch"
	EventSessionBeforeFork    = "session_before_fork"
	EventSessionBeforeCompact = "session_before_compact"
	EventSessionCompact       = "session_compact"
	EventSessionCompactFailed = "session_compact_failed"
	EventSessionShutdown      = "session_shutdown"
	EventSessionBeforeTree    = "session_before_tree"
	EventSessionTree          = "session_tree"

	// Context and provider requests.
	EventContext               = "context"
	EventContextWithSystem     = "context_with_system"
	EventCacheWarmingDecision  = "cache_warming_decision"
	EventBeforeProviderRequest = "before_provider_request"
	EventBeforeProviderHeaders = "before_provider_headers"
	EventAfterProviderResponse = "after_provider_response"
	// EventProviderStreamEvent fires for a parsed provider stream event before it is normalized. The data is adapter-owned and read-only.
	EventProviderStreamEvent = "provider_stream_event"

	// EventMcpServersChange fires when an extension registers or unregisters an MCP server after the extensions are bound; the data carries every registered server. Handling it marks an extension as the one that connects registered servers.
	EventMcpServersChange = "mcp_servers_change"

	// Agent loop and interactive prompts.
	EventBeforeAgentStart  = "before_agent_start"
	EventAgentStart        = "agent_start"
	EventAgentEnd          = "agent_end"
	EventAgentBeforeSettle = "agent_before_settle"
	EventAgentSettled      = "agent_settled"
	EventUIPromptStart     = "ui_prompt_start"
	EventUIPromptEnd       = "ui_prompt_end"
	EventTurnStart         = "turn_start"
	EventTurnEnd           = "turn_end"

	// Messages and tool execution.
	EventMessageStart        = "message_start"
	EventMessageUpdate       = "message_update"
	EventMessageEnd          = "message_end"
	EventToolExecutionStart  = "tool_execution_start"
	EventToolExecutionUpdate = "tool_execution_update"
	EventToolExecutionEnd    = "tool_execution_end"

	// Selection, tool interception and input.
	EventModelSelect         = "model_select"
	EventThinkingLevelSelect = "thinking_level_select"
	EventToolCall            = "tool_call"
	EventToolResult          = "tool_result"
	EventUserBash            = "user_bash"
	EventInput               = "input"
)

// OnProviderStreamEvent registers a handler for the provider_stream_event event and returns an idempotent unsubscribe function.
//
// upstream: types.ts:1580 (on("provider_stream_event", ...))
func (e *Extension) OnProviderStreamEvent(handler EventFunc) func() {
	return e.OnEvent(EventProviderStreamEvent, handler)
}

// OnMcpServersChange registers a handler for the mcp_servers_change event and returns an idempotent unsubscribe function. Handling the event marks the extension as the one that connects registered MCP servers.
//
// upstream: types.ts:1562 (on("mcp_servers_change", ...))
func (e *Extension) OnMcpServersChange(handler EventFunc) func() {
	return e.OnEvent(EventMcpServersChange, handler)
}
