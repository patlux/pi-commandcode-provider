package sdk

import (
	"fmt"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// AutocompleteItem mirrors @earendil-works/pi-tui AutocompleteItem: Value is
// inserted, Label is shown in place of Value when set.
type AutocompleteItem struct {
	Value       string `json:"value"`
	Label       string `json:"label,omitempty"`
	Description string `json:"description,omitempty"`
}

// ArgumentCompletionsFunc mirrors upstream RegisteredCommand
// getArgumentCompletions: the items for the text after "/<command> ", or nil
// for none.
type ArgumentCompletionsFunc func(argumentPrefix string) ([]AutocompleteItem, error)

// CommandOptions mirrors upstream registerCommand's options: the
// description, getArgumentCompletions and handler.
type CommandOptions struct {
	Description            string
	GetArgumentCompletions ArgumentCompletionsFunc
	Handler                CommandFunc
}

// RegisterCommand registers a slash command with upstream's options, as
// pi.registerCommand(name, options) does.
func (e *Extension) RegisterCommand(name string, options CommandOptions) {
	e.validateCommand(name, options.Handler != nil)
	e.commands = append(e.commands, cmdDef{
		Name:                name,
		Description:         options.Description,
		ArgumentCompletions: options.GetArgumentCompletions != nil,
	})
	e.commandFuncs[name] = options.Handler
	if options.GetArgumentCompletions != nil {
		e.commandCompletions[name] = options.GetArgumentCompletions
	}
}

// commandArgumentCompletions answers the host's command_argument_completions
// request: the items as a JSON array, or null for none.
func (e *Extension) commandArgumentCompletions(name string, rawPrefix json.RawMessage) (any, error) {
	complete, ok := e.commandCompletions[name]
	if !ok {
		return nil, fmt.Errorf("command %s has no getArgumentCompletions", name)
	}
	var prefix string
	if len(rawPrefix) > 0 {
		_ = json.Unmarshal(rawPrefix, &prefix)
	}
	items, err := complete(prefix)
	if err != nil || len(items) == 0 {
		return nil, err
	}
	return items, nil
}

// validateCommand rejects a command without a name or a handler before it registers, so the extension fails to load instead of crashing the host when `/` lists its commands.
// upstream: packages/coding-agent/src/core/extensions/loader.ts:302-311
func (e *Extension) validateCommand(name string, hasHandler bool) {
	if name == "" {
		panic(fmt.Errorf(`Command registered by extension "%s" must have a non-empty string name. Use pi.registerCommand("name", { description, handler }).`, e.name))
	}
	if !hasHandler {
		panic(fmt.Errorf(`Command "/%s" registered by extension "%s" must define handler().`, name, e.name))
	}
}
