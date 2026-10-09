package sdk

import (
	"errors"
	"fmt"
	"os"
	"slices"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// Ports packages/coding-agent/src/core/mcp-servers.ts (McpServerConfig, RegisteredMcpServer).
// Ports packages/coding-agent/src/core/extensions/loader.ts (registerMcpServer, unregisterMcpServer, getMcpServers).

// McpExposure selects how the model reaches the tools of an MCP server.
//
//   - codemode: tools are callable from codemode scripts, but not declared to the model and not listed in its description, which lists only the server's namespace. Scripts find them with searchTools(). "codemode-deferred" is accepted as an alias.
//   - deferred: not declared to the model until the tool_search tool loads them.
//   - direct: tools are declared to the model like any other tool (and callable from codemode).
//   - hidden: tools are registered but unreachable.
//
// upstream: mcp-servers.ts (McpExposure)
type McpExposure string

// The exposures of upstream's McpExposure union.
const (
	McpExposureCodemode McpExposure = "codemode"
	McpExposureDeferred McpExposure = "deferred"
	McpExposureDirect   McpExposure = "direct"
	McpExposureHidden   McpExposure = "hidden"
)

// McpOAuthConfig is OAuth client settings for servers that do not support dynamic client registration.
type McpOAuthConfig struct {
	ClientID     string `json:"clientId,omitempty"`
	ClientSecret string `json:"clientSecret,omitempty"`
	CallbackPort *int   `json:"callbackPort,omitempty"`
	CallbackURL  string `json:"callbackUrl,omitempty"`
	Scope        string `json:"scope,omitempty"`
	// ClientName is the `client_name` sent with dynamic client registration, for servers that only accept known
	// clients. Default: the app name.
	ClientName string `json:"clientName,omitempty"`
	// AuthServerMetadataURL is an authorization server metadata document (RFC 8414 or OpenID Connect discovery) to use
	// instead of discovery through the server, for servers that advertise a wrong authorization server or none. The
	// document is trusted as configured. It must use https, except on loopback hosts.
	AuthServerMetadataURL string `json:"authServerMetadataUrl,omitempty"`
}

// McpAuthConfig sends the token of a pi provider (`/login <provider>`) as the bearer token instead of using OAuth. It is only allowed in the global mcp.json and from extensions, and requires https except on loopback hosts.
type McpAuthConfig struct {
	Provider string `json:"provider"`
}

// McpServerConfig is one server entry of the `mcpServers` shape: a stdio server (Command set) or a streamable HTTP server (URL set), upstream's McpStdioServerConfig | McpHttpServerConfig union. The host validates it.
type McpServerConfig struct {
	// Type is "stdio" or "http"; "streamable-http" is accepted for HTTP servers.
	Type string `json:"type,omitempty"`
	// Exposure defaults to codemode.
	Exposure McpExposure `json:"exposure,omitempty"`
	// Description is what the server offers, in a sentence. The `mcp_servers` system prompt section lists the server with it, tool search ranks the server's tools by it, and codemode's `describeNamespace()` returns it.
	Description string `json:"description,omitempty"`
	// ToolExposure overrides Exposure for single tools.
	ToolExposure *OrderedExposures `json:"toolExposure,omitempty"`
	// Enabled set to false keeps the entry without connecting. Default: true.
	Enabled *bool `json:"enabled,omitempty"`
	// Timeout is the per-request timeout in seconds. Default: 60.
	Timeout *float64 `json:"timeout,omitempty"`

	// Stdio servers.
	Command string          `json:"command,omitempty"`
	Args    []string        `json:"args,omitempty"`
	Env     *OrderedStrings `json:"env,omitempty"`
	Cwd     string          `json:"cwd,omitempty"`

	// HTTP servers.
	URL     string          `json:"url,omitempty"`
	Headers *OrderedStrings `json:"headers,omitempty"`
	OAuth   *McpOAuthConfig `json:"oauth,omitempty"`
	// Auth sends a provider's token instead of using OAuth.
	Auth *McpAuthConfig `json:"auth,omitempty"`
}

// RegisteredMcpServer is a server an extension registered with RegisterMcpServer.
type RegisteredMcpServer struct {
	Name   string          `json:"name"`
	Config McpServerConfig `json:"config"`
	// ExtensionPath is the path of the extension that registered the server.
	ExtensionPath string `json:"extensionPath"`
}

// RegisterMcpServer registers an MCP server for this session, with the same config as an `mcpServers` entry in `mcp.json`. Registering a name again replaces the extension's earlier registration. The registration is not saved; register again on every load.
//
// Before [Extension.Run] the registration is queued and the host applies it when the extension loads, as upstream applies the registrations of a factory that returned; the host validates the config and a failure fails the load with upstream's message. After the extension loaded, the host applies it at once and the error is upstream's throw: an invalid config, or a name another extension registered.
//
// upstream: loader.ts:456-465 (registerMcpServer)
func (e *Extension) RegisterMcpServer(name string, config McpServerConfig) error {
	return e.registerMcpServer(nil, mcpServerDecl{Name: name, Config: config})
}

// UnregisterMcpServer removes an MCP server this extension registered and closes its connection. A failure of the host call is reported where the host shows extension output.
//
// upstream: loader.ts:468-471 (unregisterMcpServer)
func (e *Extension) UnregisterMcpServer(name string) {
	e.unregisterMcpServer(nil, name)
}

// RegisterMcpServer registers an MCP server; see [Extension.RegisterMcpServer].
func (c Context) RegisterMcpServer(name string, config McpServerConfig) error {
	return c.ext.registerMcpServer(&c, mcpServerDecl{Name: name, Config: config})
}

// UnregisterMcpServer removes an MCP server this extension registered.
func (c Context) UnregisterMcpServer(name string) {
	c.ext.unregisterMcpServer(&c, name)
}

// GetMcpServers returns every MCP server registered by extensions, in registration order, for extensions that connect MCP servers. It reads the state the host replicated, which every registration call and every host state update refreshes.
//
// upstream: loader.ts:473-476 (getMcpServers)
func (c Context) GetMcpServers() ([]RegisteredMcpServer, error) {
	c.ext.mu.RLock()
	raw := c.ext.mcpServersRaw
	c.ext.mu.RUnlock()
	if raw == nil {
		return nil, errors.New("the host sent no MCP server list")
	}
	var servers []RegisteredMcpServer
	if err := json.Unmarshal(raw, &servers); err != nil {
		return nil, fmt.Errorf("decode the host's MCP server list: %w", err)
	}
	if servers == nil {
		servers = []RegisteredMcpServer{}
	}
	return servers, nil
}

func (e *Extension) registerMcpServer(c *Context, decl mcpServerDecl) error {
	e.toolMu.Lock()
	conn := e.toolConn
	if conn == nil {
		defer e.toolMu.Unlock()
		for i := range e.mcpServerDecls {
			if e.mcpServerDecls[i].Name == decl.Name {
				e.mcpServerDecls[i] = decl
				return nil
			}
		}
		e.mcpServerDecls = append(e.mcpServerDecls, decl)
		return nil
	}
	e.toolMu.Unlock()
	return e.mcpServersCall(c, conn, "registerMcpServer", decl)
}

func (e *Extension) unregisterMcpServer(c *Context, name string) {
	e.toolMu.Lock()
	conn := e.toolConn
	if conn == nil {
		defer e.toolMu.Unlock()
		e.mcpServerDecls = slices.DeleteFunc(e.mcpServerDecls, func(decl mcpServerDecl) bool { return decl.Name == name })
		return
	}
	e.toolMu.Unlock()
	if err := e.mcpServersCall(c, conn, "unregisterMcpServer", struct {
		Name string `json:"name"`
	}{name}); err != nil {
		fmt.Fprintf(os.Stderr, "pig: host call unregisterMcpServer failed: %v\n", err)
	}
}

// mcpServersCall makes one MCP registration call and installs the server list of its reply as the replicated list, so the caller's next GetMcpServers sees the change.
func (e *Extension) mcpServersCall(c *Context, conn *conn, method string, args any) error {
	result, err := hostCallFor(c, conn, method, args)
	if err := callResultError(result, err); err != nil {
		return err
	}
	if result == nil {
		return fmt.Errorf("host returned no result for %s", method)
	}
	var reply struct {
		Servers json.RawMessage `json:"servers"`
	}
	if err := json.Unmarshal(result.Result, &reply); err != nil {
		return fmt.Errorf("host reply to %s: %w", method, err)
	}
	if reply.Servers != nil {
		// The host sends a state update before it replies, and the message loop may apply it after the read loop routed the reply here. The reply is newer than every notify read before it, so their lists never replace it; a later state does.
		at := 2*result.notifySeq + 1
		e.mu.Lock()
		if at >= e.mcpServersAt {
			e.mcpServersRaw = reply.Servers
			e.mcpServersAt = at
		}
		e.mu.Unlock()
	}
	return nil
}

// hostCallFor makes one host call for a registration API. A call from a handler goes through its Context, so the host sees the request as blocked on the call; a call made outside a handler goes straight to the connection.
func hostCallFor(c *Context, conn *conn, method string, args any) (*callResultMsg, error) {
	if c != nil {
		return c.callHost(method, args)
	}
	return conn.call(method, args)
}
