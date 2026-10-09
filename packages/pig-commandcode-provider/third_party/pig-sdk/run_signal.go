package sdk

import (
	"context"
	"encoding/json"
	"sync"
)

const notifyRunSignal = "run_signal"

// runSignal is the replicated signal of the run in progress: one context for the whole run, cancelled when the run aborts.
type runSignal struct {
	mu     sync.Mutex
	id     uint64
	ctx    context.Context
	cancel context.CancelFunc
}

// apply installs the host's run_signal frame. A frame of a run the extension does not hold begins a new run.
func (r *runSignal) apply(args json.RawMessage) {
	var frame struct {
		Run     uint64 `json:"run"`
		Active  bool   `json:"active"`
		Aborted bool   `json:"aborted"`
	}
	if json.Unmarshal(args, &frame) != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !frame.Active {
		r.ctx, r.cancel = nil, nil
		return
	}
	if r.ctx == nil || r.id != frame.Run {
		r.id = frame.Run
		r.ctx, r.cancel = context.WithCancel(context.Background())
	}
	if frame.Aborted {
		r.cancel()
	}
}

func (r *runSignal) current() context.Context {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ctx
}

// Signal is upstream's ctx.signal: the cancellation of the run in progress, or nil while no run is active. Every read during one run returns the same context, and aborting the run cancels it, including for a handler still in flight. It is the run's, not the request's: Done and Err report the request.
func (c Context) Signal() context.Context {
	return c.ext.run.current()
}
