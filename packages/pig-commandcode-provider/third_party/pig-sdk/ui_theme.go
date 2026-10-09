// SPDX-FileCopyrightText: Copyright Hewlett Packard Enterprise Development LP
// SPDX-License-Identifier: MIT

package sdk

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"strings"
)

// UITheme is the host's active theme as extensions see it (upstream
// ctx.ui.theme): its name, the file a custom theme was loaded from, and the
// escape sequences the host resolved for each color token. The host
// replicates it with the state snapshot and every theme change; get the
// current one with [Context.UITheme].
//
// Methods port upstream Theme (modes/interactive/theme/theme.ts) over that
// palette, as the Node runtime's ThemeShim does. The zero value styles text
// with modifiers only, like a runtime that has not yet received a palette.
type UITheme struct {
	// Name is the theme's name.
	Name string
	// SourcePath is upstream Theme.sourcePath: the file a custom theme was
	// loaded from, empty for a built-in theme.
	SourcePath string

	foregrounds map[string]string
	backgrounds map[string]string
	// noModifiers is the host's modifiers=false: its chalk draws no bold,
	// italic, underline, inverse or strikethrough.
	noModifiers bool
	mode        string
	appearance  ThemeAppearance
	colors      map[string]Color
}

// themePalette is the wire shape of the host's theme palette.
type themePalette struct {
	Name        any            `json:"name"`
	SourcePath  any            `json:"sourcePath"`
	Foregrounds map[string]any `json:"foregrounds"`
	Backgrounds map[string]any `json:"backgrounds"`
	Modifiers   *bool          `json:"modifiers"`
	Mode        any            `json:"mode"`
	Appearance  any            `json:"appearance"`
	Colors      map[string]any `json:"colors"`
}

// decodeUITheme builds a UITheme from a host palette, as ThemeShim.setPalette
// does. ok is false when raw is not a JSON object.
func decodeUITheme(raw json.RawMessage) (UITheme, bool) {
	var probe any
	if len(raw) == 0 || json.Unmarshal(raw, &probe) != nil {
		return UITheme{}, false
	}
	if _, isObject := probe.(map[string]any); !isObject {
		return UITheme{}, false
	}
	var palette themePalette
	_ = json.Unmarshal(raw, &palette)
	theme := UITheme{
		foregrounds: ansiTokens(palette.Foregrounds),
		backgrounds: ansiTokens(palette.Backgrounds),
		noModifiers: palette.Modifiers != nil && !*palette.Modifiers,
		mode:        "truecolor",
		colors:      decodeThemeColors(palette.Colors),
	}
	if appearance, ok := palette.Appearance.(string); ok && (appearance == "light" || appearance == "dark") {
		theme.appearance = ThemeAppearance(appearance)
	}
	if name, ok := palette.Name.(string); ok {
		theme.Name = name
	}
	if path, ok := palette.SourcePath.(string); ok {
		theme.SourcePath = path
	}
	if mode, ok := palette.Mode.(string); ok && mode == "256color" {
		theme.mode = mode
	}
	return theme, true
}

// decodeThemeColors keeps the colors whose wire object is a well-formed pi-tui Color; any other value is not a color and is dropped, as a token without an escape sequence is.
func decodeThemeColors(values map[string]any) map[string]Color {
	colors := make(map[string]Color, len(values))
	for token, value := range values {
		object, _ := value.(map[string]any)
		channel := func(key string) (float64, bool) {
			number, ok := object[key].(float64)
			return number, ok
		}
		switch object["kind"] {
		case "indexed":
			if index, ok := channel("index"); ok && index == math.Trunc(index) && index >= 0 && index <= 255 {
				colors[token] = IndexedColor{Index: int(index)}
			}
		case "rgb":
			r, rok := channel("r")
			g, gok := channel("g")
			b, bok := channel("b")
			if rok && gok && bok {
				colors[token] = RgbColorValue{R: r, G: g, B: b}
			}
		case "oklch":
			l, lok := channel("l")
			c, cok := channel("c")
			h, hok := channel("h")
			if lok && cok && hok {
				colors[token] = OklchColorValue{L: l, C: c, H: h}
			}
		}
	}
	return colors
}

// ansiTokens keeps the tokens whose escape sequence is a non-empty string; any
// other value resolves as an unknown token.
func ansiTokens(values map[string]any) map[string]string {
	tokens := make(map[string]string, len(values))
	for token, value := range values {
		if ansi, ok := value.(string); ok && ansi != "" {
			tokens[token] = ansi
		}
	}
	return tokens
}

// faintOpening is the SGR 2 suffix the host appends to the foreground of a faint token (theme.ts:399-402).
const faintOpening = "\x1b[2m"

// Fg colors text with the foreground of token and resets the foreground, and
// the faint attribute of a faint token (upstream Theme.fg, theme.ts:363). An
// unknown token leaves text uncolored.
func (t UITheme) Fg(token, text string) string {
	open := t.foregrounds[token]
	if open == "" {
		return text
	}
	if strings.HasSuffix(open, faintOpening) {
		return open + text + "\x1b[22;39m"
	}
	return open + text + "\x1b[39m"
}

// Bg colors text with the background of token and resets only the
// background. An unknown token leaves text uncolored.
func (t UITheme) Bg(token, text string) string {
	open := t.backgrounds[token]
	if open == "" {
		return text
	}
	return open + text + "\x1b[49m"
}

func (t UITheme) style(open, closing, text string) string {
	if t.noModifiers {
		return text
	}
	return open + text + closing
}

// Bold draws text bold.
func (t UITheme) Bold(text string) string { return t.style("\x1b[1m", "\x1b[22m", text) }

// Italic draws text italic.
func (t UITheme) Italic(text string) string { return t.style("\x1b[3m", "\x1b[23m", text) }

// Underline draws text underlined.
func (t UITheme) Underline(text string) string { return t.style("\x1b[4m", "\x1b[24m", text) }

// Inverse draws text with foreground and background swapped.
func (t UITheme) Inverse(text string) string { return t.style("\x1b[7m", "\x1b[27m", text) }

// Strikethrough draws text struck through.
func (t UITheme) Strikethrough(text string) string { return t.style("\x1b[9m", "\x1b[29m", text) }

// GetFgAnsi returns the foreground escape sequence of token, or upstream's
// "Unknown theme color" error.
func (t UITheme) GetFgAnsi(token string) (string, error) {
	ansi := t.foregrounds[token]
	if ansi == "" {
		return "", fmt.Errorf("Unknown theme color: %s", token)
	}
	return ansi, nil
}

// GetBgAnsi returns the background escape sequence of token, or upstream's
// "Unknown theme background color" error.
func (t UITheme) GetBgAnsi(token string) (string, error) {
	ansi := t.backgrounds[token]
	if ansi == "" {
		return "", fmt.Errorf("Unknown theme background color: %s", token)
	}
	return ansi, nil
}

// GetColorMode returns the host terminal's color mode: "truecolor" or
// "256color".
func (t UITheme) GetColorMode() string {
	if t.mode == "" {
		return "truecolor"
	}
	return t.mode
}

// thinkingBorderTokens maps a thinking level to its border color token, as
// upstream Theme.getThinkingBorderColor does.
var thinkingBorderTokens = map[string]string{
	"off":     "thinkingOff",
	"minimal": "thinkingMinimal",
	"low":     "thinkingLow",
	"medium":  "thinkingMedium",
	"high":    "thinkingHigh",
	"xhigh":   "thinkingXhigh",
	"max":     "thinkingMax",
}

// GetThinkingBorderColor returns the editor border colorizer for a thinking
// level. An unknown level uses the "off" color.
func (t UITheme) GetThinkingBorderColor(level string) func(string) string {
	token, ok := thinkingBorderTokens[level]
	if !ok {
		token = "thinkingOff"
	}
	return func(text string) string { return t.Fg(token, text) }
}

// GetBashModeBorderColor returns the editor border colorizer for bash mode.
func (t UITheme) GetBashModeBorderColor() func(string) string {
	return func(text string) string { return t.Fg("bashMode", text) }
}

// ThemeAppearance is the background a theme is designed for (upstream ThemeAppearance): "light" or "dark".
type ThemeAppearance string

// Color is a concrete color (upstream pi-tui Color): [IndexedColor], [RgbColorValue] or [OklchColorValue]. The union is closed; the unexported method seals it.
type Color interface{ isColor() }

// IndexedColor is an ANSI palette index, 0-255 (kind "indexed").
type IndexedColor struct{ Index int }

// RgbColorValue is an sRGB color with channels 0-255 (kind "rgb").
type RgbColorValue struct{ R, G, B float64 }

// OklchColorValue is an OKLCH color (kind "oklch"): lightness 0-1, chroma and hue in degrees.
type OklchColorValue struct{ L, C, H float64 }

func (IndexedColor) isColor()    {}
func (RgbColorValue) isColor()   {}
func (OklchColorValue) isColor() {}

// TextAttributes are the text attributes theme.style applies (upstream pi-tui TextAttributes).
type TextAttributes struct {
	Bold, Dim, Italic, Underline, Inverse, Strikethrough bool
}

// ThemeStyle is the style [UITheme.Style] applies (upstream ThemeStyle): a foreground and a background, each a theme token or a concrete Color, and text attributes. Upstream's one `fg` field holds a token or a Color; Go uses a field per form. Setting both the token and the color of a slot is an error.
type ThemeStyle struct {
	TextAttributes
	FgToken, BgToken string
	Fg, Bg           Color
}

// Appearance is the background the theme is designed for: declared in the theme JSON, detected from its colors, or for a theme without usable colors the terminal's appearance. The host resolves it with the palette; it is empty before the host has sent one.
func (t UITheme) Appearance() ThemeAppearance { return t.appearance }

// Colors returns a concrete color for every theme token (upstream Theme.colors). A token set to the terminal default carries the terminal's reported color, or the host's guess from the appearance, and a faint token is mixed toward the background. The host resolves them with the palette. The map is a copy.
func (t UITheme) Colors() map[string]Color { return maps.Clone(t.colors) }

// Style renders text in style (upstream Theme.style). A token is accepted only in its own slot, because "" (terminal default) means the default foreground or background depending on the slot. An unknown token is upstream's "Unknown theme color" error. A color renders in the theme's color mode. Unlike [UITheme.Bold], the attributes are drawn whatever the host's chalk level is.
func (t UITheme) Style(text string, style ThemeStyle) (string, error) {
	if (style.FgToken != "" && style.Fg != nil) || (style.BgToken != "" && style.Bg != nil) {
		return "", errors.New("theme style sets both a token and a color for one slot")
	}
	attributes := style.TextAttributes
	var fgAnsi, bgAnsi string
	switch {
	case style.FgToken != "":
		ansi := t.foregrounds[style.FgToken]
		if ansi == "" {
			return "", fmt.Errorf("Unknown theme color: %s", style.FgToken)
		}
		// The palette's foreground appends SGR 2 to a faint token's color; a color never ends in it.
		if open, faint := strings.CutSuffix(ansi, faintOpening); faint {
			ansi = open
			attributes.Dim = true
		}
		fgAnsi = ansi
	case style.Fg != nil:
		fgAnsi = colorAnsi(style.Fg, t.GetColorMode(), false)
	}
	switch {
	case style.BgToken != "":
		ansi := t.backgrounds[style.BgToken]
		if ansi == "" {
			return "", fmt.Errorf("Unknown theme color: %s", style.BgToken)
		}
		bgAnsi = ansi
	case style.Bg != nil:
		bgAnsi = colorAnsi(style.Bg, t.GetColorMode(), true)
	}
	return styleTextWithAnsi(text, fgAnsi, bgAnsi, attributes), nil
}

// UITheme returns a snapshot of the host's active theme (upstream
// ctx.ui.theme), replicated from the state snapshot and theme changes.
func (c Context) UITheme() UITheme {
	c.ext.mu.RLock()
	defer c.ext.mu.RUnlock()
	// A palette is replaced whole and never mutated, so the snapshot can
	// share its maps.
	return c.ext.uiTheme
}
