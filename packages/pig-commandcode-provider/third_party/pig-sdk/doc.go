// Package sdk provides the Go SDK for building pig subprocess extensions.
//
// An extension is a standalone binary that communicates with pig over a Unix
// domain socket using length-prefixed JSON framing. This package handles all
// protocol details: connection, registration, request/response correlation,
// and graceful shutdown.
//
// # Quick Start
//
//	func main() {
//	    ext := sdk.New("my-extension")
//
//	    ext.Tool("greet", "Say hello", sdk.Schema{
//	        "type": "object",
//	        "properties": map[string]any{
//	            "name": map[string]any{"type": "string"},
//	        },
//	    }, func(ctx sdk.Context, params map[string]any) (any, error) {
//	        name, _ := params["name"].(string)
//	        return map[string]any{"greeting": "Hello, " + name + "!"}, nil
//	    })
//
//	    ext.Command("hello", "Say hello", func(ctx sdk.Context, args string) error {
//	        ctx.Notify("Hello from extension!", "info")
//	        return nil
//	    })
//
//	    ext.OnSessionStart(func(ctx sdk.Context, event map[string]any) error {
//	        ctx.Notify("Extension loaded", "info")
//	        return nil
//	    })
//
//	    ext.Run() // Blocks until shutdown
//	}
//
// # JavaScript strings
//
// Terminal and editor strings preserve UTF-16 code units. Lone surrogates use WTF-8 in Go strings and standard Unicode escapes in JSON. The SDK owns that conversion; use extensions/sdk/json rather than encoding/json when serializing such callback text yourself.
//
// # Architecture
//
// The SDK connects to pig's extension host via a Unix domain socket whose
// path is passed in the PIG_EXT_SOCKET environment variable. The protocol
// uses 4-byte big-endian length-prefixed JSON messages.
//
// Message flow:
//   - Extension → Host: register (tools, commands, handlers)
//   - Host → Extension: ready (session info)
//   - Host → Extension: request (tool execute, command, event)
//   - Extension → Host: response
//   - Extension → Host: call (ui.notify, sendMessage, etc.)
//   - Host → Extension: call_result
//   - Extension → Host: widget_push (a string list widget)
//   - Host → Extension: shutdown
package sdk
