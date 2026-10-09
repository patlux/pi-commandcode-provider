package sdk

import (
	"fmt"
	"sync"
)

// A footer or header renderer is the subprocess form of Pi's component factory:
// the TUI calls render(width) for every frame (interactive-mode.ts:2418-2480).
// The SDK renders at the width the host reported, sends the rows with that
// width so the host never paints them at another, and renders again after each
// width_change. Only the newest width is rendered when several arrive together.

const (
	footerMethod = "ui.setFooter"
	headerMethod = "ui.setHeader"
)

// pig additive (D19): Pi installs a footer or header as an in-process component
// factory that the TUI renders every frame; a subprocess SDK renders at the host
// width itself and sends the width with the rows.
type surfaceRenderer struct {
	method string
	render func(width int) []string

	// mu serializes a render with its push and orders a push against stop, so a
	// superseded renderer never overwrites the rows that replaced it.
	mu      sync.Mutex
	stopped bool

	refreshMu      sync.Mutex
	refreshQueued  bool
	refreshRunning bool
}

func surfaceKind(method string) string {
	if method == headerMethod {
		return "header"
	}
	return "footer"
}

// push renders at the current host width and sends the rows tagged with it. A
// panicking renderer is reported as the Node runtime reports a failing
// component (runtime.mjs renderSpecialSurface) and leaves the previous rows.
func (s *surfaceRenderer) push(c Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return nil
	}
	width := c.Width()
	lines, ok := s.renderSafely(c, width)
	if !ok {
		return nil
	}
	result, err := c.callHost(s.method, surfaceArgs(lines, width))
	return callResultError(result, err)
}

func (s *surfaceRenderer) renderSafely(c Context, width int) (lines []string, ok bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			c.Notify(fmt.Sprintf("%s render failed: %v", surfaceKind(s.method), recovered), "error")
			lines, ok = nil, false
		}
	}()
	return s.render(width), true
}

// stop retires the renderer once any push in flight has finished.
func (s *surfaceRenderer) stop() {
	s.mu.Lock()
	s.stopped = true
	s.mu.Unlock()
}

// refresh renders again off the message loop, coalescing calls that arrive while
// a push is in flight into one more push at the newest width.
func (s *surfaceRenderer) refresh(c Context) {
	s.refreshMu.Lock()
	s.refreshQueued = true
	if s.refreshRunning {
		s.refreshMu.Unlock()
		return
	}
	s.refreshRunning = true
	s.refreshMu.Unlock()
	go func() {
		for {
			s.refreshMu.Lock()
			if !s.refreshQueued {
				s.refreshRunning = false
				s.refreshMu.Unlock()
				return
			}
			s.refreshQueued = false
			s.refreshMu.Unlock()
			_ = s.push(c)
		}
	}()
}

func surfaceArgs(lines []string, width int) map[string]any {
	if lines == nil {
		lines = []string{}
	}
	args := map[string]any{"lines": lines}
	if width > 0 {
		args["width"] = width
	}
	return args
}

// replaceSurface retires the renderer installed for method and installs next
// (nil for none).
func (e *Extension) replaceSurface(method string, next *surfaceRenderer) {
	e.surfaceMu.Lock()
	previous := e.surfaces[method]
	if next == nil {
		delete(e.surfaces, method)
	} else {
		if e.surfaces == nil {
			e.surfaces = map[string]*surfaceRenderer{}
		}
		e.surfaces[method] = next
	}
	e.surfaceMu.Unlock()
	if previous != nil {
		previous.stop()
	}
}

// refreshSurfaces renders every installed renderer again at the host's width.
func (e *Extension) refreshSurfaces() {
	e.surfaceMu.Lock()
	renderers := make([]*surfaceRenderer, 0, len(e.surfaces))
	for _, s := range e.surfaces {
		renderers = append(renderers, s)
	}
	e.surfaceMu.Unlock()
	c := Context{ext: e}
	for _, s := range renderers {
		s.refresh(c)
	}
}

func (c Context) setSurface(method string, lines []string) error {
	c.ext.replaceSurface(method, nil)
	if lines == nil {
		result, err := c.callHost(method, map[string]any{"clear": true})
		return callResultError(result, err)
	}
	result, err := c.callHost(method, surfaceArgs(lines, c.Width()))
	return callResultError(result, err)
}

func (c Context) setSurfaceRenderer(method string, render func(width int) []string) error {
	if render == nil {
		return c.setSurface(method, nil)
	}
	next := &surfaceRenderer{method: method, render: render}
	c.ext.replaceSurface(method, next)
	return next.push(c)
}

// SetFooterRenderer installs a footer that render lays out at the host's
// terminal width, the subprocess form of the component factory Pi's
// ctx.ui.setFooter takes. The SDK renders at the width the host reports and
// again after every width change, and sends each set of rows with the width it
// was rendered for, so the host never paints rows laid out for another width.
// A nil render restores the built-in footer. A panic in render is reported to
// the user as "footer render failed: ..." and leaves the previous rows.
func (c Context) SetFooterRenderer(render func(width int) []string) error {
	return c.setSurfaceRenderer(footerMethod, render)
}

// SetHeaderRenderer installs a header that render lays out at the host's
// terminal width; it follows the same contract as [Context.SetFooterRenderer].
func (c Context) SetHeaderRenderer(render func(width int) []string) error {
	return c.setSurfaceRenderer(headerMethod, render)
}
