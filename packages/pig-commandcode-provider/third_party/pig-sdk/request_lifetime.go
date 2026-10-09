package sdk

import (
	"context"
	"fmt"
)

// requestParent separates an active handler's cancellation scope from a retained Context's runtime lifetime. The connection's write mutex orders parent selection with response publication.
// pig additive (D19): retained SDK contexts keep their original connection generation after normal request completion.
type requestParent struct {
	conn      *conn
	id        string
	runtime   context.Context
	request   context.Context
	completed bool
	finished  bool
	cancelled bool
}

func (c *conn) armParent(id string, runtime, request context.Context) *requestParent {
	parent := &requestParent{conn: c, id: id, runtime: runtime, request: request}
	c.pendingMu.Lock()
	if c.requestParents == nil {
		c.requestParents = make(map[string]*requestParent)
	}
	c.requestParents[id] = parent
	c.pendingMu.Unlock()
	return parent
}

func (c Context) hostConnection() *conn {
	if c.parent != nil {
		return c.parent.conn
	}
	return c.ext.conn
}

func (c Context) beginHostCall(method string, args any) (pendingCall, error) {
	connection := c.hostConnection()
	if c.parent == nil {
		return connection.beginCallFor(c.requestID, method, args)
	}
	return connection.beginParentCall(c.parent, method, args)
}

func (p *requestParent) lifetime() (context.Context, bool) {
	p.conn.pendingMu.Lock()
	defer p.conn.pendingMu.Unlock()
	return p.runtime, p.completed
}

func (p *requestParent) report(state, reason string) {
	c := p.conn
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.pendingMu.Lock()
	active := !p.finished && (!p.cancelled || state == "progress")
	c.pendingMu.Unlock()
	if active {
		_ = c.sendLocked(envelope{Type: msgRequestState, RequestState: &requestStateMsg{RequestID: p.id, State: state, Reason: reason}})
	}
}

func (c *conn) parentIDLocked(parent *requestParent) (string, error) {
	if parent.cancelled {
		return "", fmt.Errorf("host call cancelled with its parent request %s", parent.id)
	}
	if err := parent.runtime.Err(); err != nil {
		return "", err
	}
	if parent.completed {
		return "", nil
	}
	return parent.id, nil
}
