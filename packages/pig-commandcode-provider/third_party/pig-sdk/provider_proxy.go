package sdk

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"runtime"
)

type providerCallbacks map[string]func(json.RawMessage) (any, error)

func (r ModelRegistry) GetRegisteredNativeProvider(id string) (*Provider, error) {
	state, err := r.state()
	if err != nil {
		return nil, err
	}
	for _, entry := range state.Registered {
		if entry.Name != id || entry.Native == nil {
			continue
		}
		e := r.context.ext
		e.providerMu.Lock()
		defer e.providerMu.Unlock()
		if local := e.nativeProviders[entry.Native.Key]; local != nil {
			return local, nil
		}
		if cached := e.providerObjectCache[entry.Native.ID]; cached != nil && cached.handle == entry.Native.Handle {
			return cached, nil
		}
		provider, err := newProviderProxy(r.context, *entry.Native)
		if err != nil {
			return nil, err
		}
		if e.providerObjectCache == nil {
			e.providerObjectCache = map[string]*Provider{}
		}
		e.providerObjectCache[entry.Native.ID] = provider
		return provider, nil
	}
	return nil, nil
}

// pig divergence (D78): builtin/composed Provider object methods still need a native SDK carrier.
func (r ModelRegistry) GetProvider(id string) (*Provider, error) {
	provider, err := r.GetRegisteredNativeProvider(id)
	if provider != nil || err != nil {
		return provider, err
	}
	state, err := r.state()
	if err != nil {
		return nil, err
	}
	if _, exists := state.Providers[id]; exists {
		return nil, errors.New("builtin/composed Provider object carrier is unavailable (D78)")
	}
	return nil, nil
}

// RegisterNativeProvider applies the native overload to the live registry and waits for publication.
func (r ModelRegistry) RegisterNativeProvider(provider *Provider) error {
	decl, err := providerDeclaration(provider, rand.Text())
	if err != nil {
		return err
	}
	e := r.context.ext
	e.providerMu.Lock()
	if e.nativeProviders == nil {
		e.nativeProviders = map[string]*Provider{}
	}
	e.nativeProviders[decl.Key] = provider
	e.providerMu.Unlock()
	result, err := r.context.callHost("registerProvider", map[string]any{"name": provider.ID, "config": map[string]any{}, "native": decl})
	return callResultError(result, err)
}

func (c Context) beginProviderCall(decl providerObjectDeclaration, method string, params any, callbacks providerCallbacks, signal context.Context, streamID string) (pendingCall, func(), error) {
	e := c.ext
	id := streamID
	if id == "" {
		id = rand.Text()
	}
	e.providerMu.Lock()
	if e.providerObjectCallbacks == nil {
		e.providerObjectCallbacks = map[string]func(string, json.RawMessage) (any, error){}
	}
	e.providerObjectCallbacks[id] = func(method string, raw json.RawMessage) (any, error) {
		fn := callbacks[method]
		if fn == nil {
			return nil, fmt.Errorf("Provider callback %s is absent", method)
		}
		return fn(raw)
	}
	e.providerMu.Unlock()
	pending, err := e.conn.beginCallFor("", "provider.object", map[string]any{"handle": decl.Handle, "method": method, "params": params, "callbackId": id, "streamId": streamID})
	var stop func() bool
	done := make(chan struct{})
	if err == nil && signal != nil {
		stop = context.AfterFunc(signal, func() {
			defer close(done)
			_, _ = e.conn.callFor("", "cancelModelStream", map[string]string{"streamId": id})
		})
	}
	cleanup := func() {
		if stop != nil && !stop() {
			<-done
		}
		e.providerMu.Lock()
		delete(e.providerObjectCallbacks, id)
		e.providerMu.Unlock()
	}
	return pending, cleanup, err
}
func providerInvoke[T any](c Context, decl providerObjectDeclaration, method string, params any, callbacks providerCallbacks, signal context.Context) (T, error) {
	defer runtime.KeepAlive(decl.lease)
	var value T
	pending, cleanup, err := c.beginProviderCall(decl, method, params, callbacks, signal, "")
	defer cleanup()
	if err != nil {
		return value, err
	}
	result, err := c.ext.conn.waitCall(pending)
	if err = callResultError(result, err); err != nil {
		return value, err
	}
	if result != nil {
		err = json.Unmarshal(result.Result, &value)
	}
	return value, err
}
func decodedProviderCallback[T any](fn func(T) (any, error)) func(json.RawMessage) (any, error) {
	return func(raw json.RawMessage) (any, error) {
		var input T
		if err := json.Unmarshal(raw, &input); err != nil {
			return nil, err
		}
		return fn(input)
	}
}
func authInputCallbacks(input APIKeyAuthInput) providerCallbacks {
	return providerCallbacks{
		"env": decodedProviderCallback(func(args struct {
			Name string `json:"name"`
		}) (any, error) {
			return input.Ctx.Env(args.Name)
		}),
		"fileExists": decodedProviderCallback(func(args struct {
			Path string `json:"path"`
		}) (any, error) {
			return input.Ctx.FileExists(args.Path)
		}),
	}
}
func interactionCallbacks(input AuthInteraction) providerCallbacks {
	return providerCallbacks{
		"prompt": decodedProviderCallback(func(args struct {
			Prompt map[string]any `json:"prompt"`
		}) (any, error) {
			return input.Prompt(args.Prompt)
		}),
		"notify": decodedProviderCallback(func(args struct {
			Event map[string]any `json:"event"`
		}) (any, error) {
			return nil, input.Notify(args.Event)
		}),
	}
}

type providerLease struct {
	handle, token string
	conn          *conn
}

func releaseProviderLease(lease providerLease) {
	_ = lease.conn.send(envelope{Type: msgCall, Call: &callMsg{Method: "provider.release", Args: mustProviderLeaseJSON(lease)}})
}
func mustProviderLeaseJSON(lease providerLease) json.RawMessage {
	data, _ := json.Marshal(map[string]string{"handle": lease.handle, "token": lease.token})
	return data
}

func newProviderProxy(ctx Context, decl providerObjectDeclaration) (*Provider, error) {
	lease := &providerLease{handle: decl.Handle, token: rand.Text(), conn: ctx.ext.conn}
	reply, err := ctx.callHost("provider.retain", map[string]string{"handle": lease.handle, "token": lease.token})
	if err := callResultError(reply, err); err != nil {
		return nil, err
	}
	runtime.AddCleanup(lease, releaseProviderLease, *lease)
	decl.lease = lease
	p := &Provider{ID: decl.ID, Name: decl.Name, BaseURL: decl.BaseURL, handle: decl.Handle}
	if decl.Headers != nil {
		p.Headers = *decl.Headers
	}
	if decl.Auth.APIKey != nil {
		p.Auth.APIKey = &APIKeyAuth{Name: decl.Auth.APIKey.Name}
	}
	if decl.Auth.OAuth != nil {
		p.Auth.OAuth = &OAuthAuth{Name: decl.Auth.OAuth.Name, IsSubscription: decl.Auth.OAuth.IsSubscription, LoginLabel: decl.Auth.OAuth.LoginLabel}
	}
	for _, method := range decl.Methods {
		switch method {
		case "getModels":
			p.GetModels = func() ([]map[string]any, error) {
				return providerInvoke[[]map[string]any](ctx, decl, method, map[string]any{}, nil, nil)
			}
		case "filterModels":
			p.FilterModels = func(models []map[string]any, credential map[string]any) ([]map[string]any, error) {
				value, err := providerInvoke[struct {
					Models  []map[string]any `json:"models"`
					Indices []int            `json:"indices"`
				}](ctx, decl, method, map[string]any{"models": models, "credential": credential}, nil, nil)
				if err != nil {
					return nil, err
				}
				for i, index := range value.Indices {
					if index >= 0 && index < len(models) {
						clear(models[index])
						maps.Copy(models[index], value.Models[i])
						value.Models[i] = models[index]
					}
				}
				return value.Models, nil
			}
		case "auth.apiKey.check":
			p.Auth.APIKey.Check = func(input APIKeyAuthInput) (*AuthCheck, error) {
				return providerInvoke[*AuthCheck](ctx, decl, method, map[string]any{"credential": input.Credential}, authInputCallbacks(input), input.Signal)
			}
		case "auth.apiKey.resolve":
			p.Auth.APIKey.Resolve = func(input APIKeyAuthInput) (*AuthResult, error) {
				return providerInvoke[*AuthResult](ctx, decl, method, map[string]any{"credential": input.Credential}, authInputCallbacks(input), input.Signal)
			}
		case "auth.apiKey.login":
			p.Auth.APIKey.Login = func(input AuthInteraction) (map[string]any, error) {
				return providerInvoke[map[string]any](ctx, decl, method, map[string]any{}, interactionCallbacks(input), input.Signal)
			}
		case "auth.oauth.login":
			p.Auth.OAuth.Login = func(input AuthInteraction) (map[string]any, error) {
				return providerInvoke[map[string]any](ctx, decl, method, map[string]any{}, interactionCallbacks(input), input.Signal)
			}
		case "auth.oauth.refresh":
			p.Auth.OAuth.Refresh = func(credential map[string]any, signal context.Context) (map[string]any, error) {
				return providerInvoke[map[string]any](ctx, decl, method, map[string]any{"credential": credential}, nil, signal)
			}
		case "auth.oauth.toAuth":
			p.Auth.OAuth.ToAuth = func(credential map[string]any) (map[string]any, error) {
				return providerInvoke[map[string]any](ctx, decl, method, map[string]any{"credential": credential}, nil, nil)
			}
		case "refreshModels":
			p.RefreshModels = func(input RefreshModelsContext) error {
				callbacks := providerCallbacks{"publish": decodedProviderCallback(func(args struct {
					Publication struct {
						Persist json.RawMessage `json:"persist"`
					} `json:"publication"`
					Token string `json:"token"`
				}) (any, error) {
					publication := ModelsPublication{Persist: args.Publication.Persist}
					if args.Token != "" {
						publication.Update = func() error {
							_, err := providerInvoke[any](ctx, decl, "update", map[string]string{"token": args.Token}, nil, input.Signal)
							return err
						}
					}
					return input.Publish(publication)
				})}
				_, err := providerInvoke[any](ctx, decl, method, map[string]any{"credential": input.Credential, "stored": input.Stored, "allowNetwork": input.AllowNetwork, "force": input.Force}, callbacks, input.Signal)
				return err
			}
		case "generateImages":
			p.GenerateImages = func(model, request map[string]any, options ProviderOperationOptions) (map[string]any, error) {
				return providerInvoke[map[string]any](ctx, decl, method, map[string]any{"model": model, "context": request, "options": options.Values}, nil, options.Signal)
			}
		case "classify":
			p.Classify = func(model map[string]any, request ClassifierContext, options ProviderOperationOptions) (ClassifierResult, error) {
				return providerInvoke[ClassifierResult](ctx, decl, method, map[string]any{"model": model, "context": request, "options": options.Values}, nil, options.Signal)
			}
		case "cancelDeferred":
			p.CancelDeferred = func(model, handle map[string]any, options ProviderStreamOptions) error {
				_, err := providerInvoke[any](ctx, decl, method, map[string]any{"model": model, "handle": handle, "options": options.Values}, nil, options.Signal)
				return err
			}
		case "stream", "streamSimple", "fetchDeferred":
			fn := func(model, transcript map[string]any, options ProviderStreamOptions) (*ModelEventStream, error) {
				return ctx.providerStream(decl, method, model, transcript, options)
			}
			switch method {
			case "stream":
				p.Stream = fn
			case "streamSimple":
				p.StreamSimple = fn
			default:
				p.FetchDeferred = fn
			}
		}
	}
	return p, nil
}
func (c Context) providerStream(decl providerObjectDeclaration, method string, model, transcript map[string]any, options ProviderStreamOptions) (*ModelEventStream, error) {
	stream := newModelEventStream()
	id := rand.Text()
	e := c.ext
	e.modelStreamsMu.Lock()
	e.modelStreams[id] = stream
	e.modelStreamsMu.Unlock()
	callbacks := providerCallbacks{}
	if options.OnPayload != nil {
		callbacks["onPayload"] = decodedProviderCallback(func(args struct {
			Value any `json:"value"`
		}) (any, error) {
			return options.OnPayload(args.Value, model)
		})
	}
	if options.OnResponse != nil {
		callbacks["onResponse"] = decodedProviderCallback(func(args struct {
			Value map[string]any `json:"value"`
		}) (any, error) {
			return nil, options.OnResponse(args.Value, model)
		})
	}
	if options.OnProviderStreamEvent != nil {
		callbacks["onProviderStreamEvent"] = decodedProviderCallback(func(args struct {
			Value any `json:"value"`
		}) (any, error) {
			return nil, options.OnProviderStreamEvent(args.Value, model)
		})
	}
	if options.TransformHeaders != nil {
		callbacks["transformHeaders"] = decodedProviderCallback(func(args struct {
			Value map[string]string `json:"value"`
		}) (any, error) {
			return options.TransformHeaders(args.Value)
		})
	}
	names := []string{}
	for _, name := range []string{"onPayload", "onResponse", "onProviderStreamEvent", "transformHeaders"} {
		if callbacks[name] != nil {
			names = append(names, name)
		}
	}
	params := map[string]any{"model": model, "options": options.Values, "callbacks": names, "aborted": options.Signal != nil && options.Signal.Err() != nil}
	if method == "fetchDeferred" {
		params["handle"] = transcript
	} else {
		params["context"] = transcript
	}
	pending, cleanup, err := c.beginProviderCall(decl, method, params, callbacks, options.Signal, id)
	if err != nil {
		cleanup()
		e.modelStreamsMu.Lock()
		delete(e.modelStreams, id)
		e.modelStreamsMu.Unlock()
		return nil, err
	}
	e.requestWG.Go(func() {
		defer runtime.KeepAlive(decl.lease)
		defer cleanup()
		result, err := e.conn.waitCall(pending)
		err = callResultError(result, err)
		if err == nil {
			err = errors.New("Provider stream ended without a terminal event")
		}
		// Apply the creation acknowledgement before inferring setup failure from the response.
		e.waitNotifications(e.conn.notifications.Load(), stream.done)
		stream.markStarted(err)
		stream.push(modelStreamErrorEvent(err, model))
		e.modelStreamsMu.Lock()
		delete(e.modelStreams, id)
		e.modelStreamsMu.Unlock()
	})
	if err := <-stream.started; err != nil {
		return nil, err
	}
	return stream, nil
}
