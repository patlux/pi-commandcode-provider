package sdk

import "sync"

// toolStartOrder starts the handlers of tool_call requests in the order the requests arrive.
//
// Pi starts every call of a parallel batch through `Promise.all(calls.map(call => run(call)))`, and each reaches tool.execute
// synchronously, so the handlers start in source order (agent-loop.ts:619-647, 820-837). The host writes a batch's tool_call requests
// in source order, but the loop runs each request on its own goroutine, and the scheduler is free to start the goroutine of a later
// request first.
//
// A handler is Go code on a preemptible thread, so the order is the order the handlers are invoked: a request's handler is invoked only
// after the handler of every earlier request was invoked or its request ended without one. Pi's single thread also orders the first
// statements of the handlers; a thread that the operating system preempts between its hand-off and its handler's first statement can
// still be overtaken, and no Go construct closes that window.
type toolStartOrder struct {
	mu   sync.Mutex
	tail chan struct{}
}

// toolStart is one request's place in the order. begin returns when every earlier request began its handler or ended without one.
type toolStart struct {
	previous <-chan struct{}
	done     chan struct{}
	once     sync.Once
}

// reserve takes the next place. The loop calls it in arrival order, before it starts the request's goroutine.
func (o *toolStartOrder) reserve() *toolStart {
	start := &toolStart{done: make(chan struct{})}
	o.mu.Lock()
	start.previous = o.tail
	o.tail = start.done
	o.mu.Unlock()
	return start
}

// begin waits for the earlier requests and then hands the place on, so the next handler starts after this one. It is idempotent.
func (s *toolStart) begin() {
	if s == nil {
		return
	}
	if s.previous != nil {
		<-s.previous
	}
	s.once.Do(func() { close(s.done) })
}

// release hands the place on for a request that ended, also one that failed before it reached its handler. Like begin it waits for the
// earlier requests first, so a request without a handler cannot let a later handler start before an earlier one. It is idempotent.
func (s *toolStart) release() { s.begin() }
