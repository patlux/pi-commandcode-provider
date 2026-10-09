package sdk

// pig additive (D60): Go extensions provide typed data for Pig's native
// login template instead of Pi's in-process TUI component factory.
// LoginDefinition describes one login using Pig's fixed native template.
// Grid cells are printable ASCII palette symbols; '.' is transparent.
type LoginDefinition struct {
	Brand       []string          `json:"brand"`
	Hero        []string          `json:"hero"`
	Mascot      []string          `json:"mascot"`
	Palette     map[string]string `json:"palette"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Tagline     string            `json:"tagline"`
}

// pig divergence (D2): Go extensions add a sprite to PiG's /sprite catalogue.
// SpriteDefinition describes one sprite: its ID, the name and tagline /sprite
// lists, its 16-by-14 pig, which the startup header draws and /sprite preview
// shows beside the wordmark, and the palette coloring it. Grid cells are
// printable ASCII palette symbols; '.' is transparent.
type SpriteDefinition struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Tagline string            `json:"tagline"`
	Mascot  []string          `json:"mascot"`
	Palette map[string]string `json:"palette"`
}
