package sdk

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
)

type providerObjectParams struct {
	Models       []map[string]any `json:"models"`
	Credential   map[string]any   `json:"credential"`
	Model        map[string]any   `json:"model"`
	Context      map[string]any   `json:"context"`
	Handle       map[string]any   `json:"handle"`
	Options      map[string]any   `json:"options"`
	Callbacks    []string         `json:"callbacks"`
	Aborted      bool             `json:"aborted"`
	Stored       map[string]any   `json:"stored"`
	AllowNetwork bool             `json:"allowNetwork"`
	Force        *bool            `json:"force"`
	Token        string           `json:"token"`
}

func providerCallbackValue[T any](ctx Context, key, method string, params any) (T, error) {
	return hostValue[T](ctx, "provider.callback", map[string]any{"provider": key, "method": method, "params": params})
}
func (e *Extension) dispatchProviderObjectCallback(req *requestMsg) (any, error) {
	e.providerMu.Lock()
	callback := e.providerObjectCallbacks[req.Tool]
	e.providerMu.Unlock()
	if callback == nil {
		return nil, errors.New("Provider callback is no longer active")
	}
	var request struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(req.Args, &request); err != nil {
		return nil, err
	}
	return callback(request.Method, request.Params)
}
func (e *Extension) dispatchProviderObject(ctx Context, req *requestMsg) (any, error) {
	var request struct {
		Method string               `json:"method"`
		Params providerObjectParams `json:"params"`
	}
	if err := json.Unmarshal(req.Args, &request); err != nil {
		return nil, err
	}
	args := request.Params
	if request.Method == "update" {
		e.providerMu.Lock()
		update := e.providerUpdates[args.Token]
		e.providerMu.Unlock()
		if update == nil {
			return nil, errors.New("Provider publication is no longer active")
		}
		return nil, update()
	}
	e.providerMu.Lock()
	provider := e.nativeProviders[req.Tool]
	e.providerMu.Unlock()
	if provider == nil {
		return nil, errors.New("Provider object is no longer registered")
	}
	input := APIKeyAuthInput{Credential: args.Credential, Signal: ctx.ctx, Ctx: AuthContext{
		Env: func(name string) (*string, error) {
			return providerCallbackValue[*string](ctx, req.Tool, "env", map[string]string{"name": name})
		},
		FileExists: func(path string) (bool, error) {
			return providerCallbackValue[bool](ctx, req.Tool, "fileExists", map[string]string{"path": path})
		},
	}}
	interaction := AuthInteraction{Signal: ctx.ctx,
		Prompt: func(prompt map[string]any) (string, error) {
			return providerCallbackValue[string](ctx, req.Tool, "prompt", map[string]any{"prompt": prompt})
		},
		Notify: func(event map[string]any) error {
			_, err := providerCallbackValue[any](ctx, req.Tool, "notify", map[string]any{"event": event})
			return err
		},
	}
	switch request.Method {
	case "getModels":
		models, err := provider.GetModels()
		if models == nil && err == nil {
			models = []map[string]any{}
		}
		return models, err
	case "filterModels":
		models, err := provider.FilterModels(args.Models, args.Credential)
		if err != nil {
			return nil, err
		}
		if models == nil {
			models = []map[string]any{}
		}
		indices := make([]int, len(models))
		for i, model := range models {
			indices[i] = -1
			for j, input := range args.Models {
				if reflect.ValueOf(model).Pointer() == reflect.ValueOf(input).Pointer() {
					indices[i] = j
					break
				}
			}
		}
		return map[string]any{"models": models, "indices": indices}, nil
	case "auth.apiKey.check":
		return provider.Auth.APIKey.Check(input)
	case "auth.apiKey.resolve":
		return provider.Auth.APIKey.Resolve(input)
	case "auth.apiKey.login":
		return provider.Auth.APIKey.Login(interaction)
	case "auth.oauth.login":
		return provider.Auth.OAuth.Login(interaction)
	case "auth.oauth.refresh":
		return provider.Auth.OAuth.Refresh(args.Credential, ctx.ctx)
	case "auth.oauth.toAuth":
		return provider.Auth.OAuth.ToAuth(args.Credential)
	case "refreshModels":
		return nil, provider.RefreshModels(RefreshModelsContext{Credential: args.Credential, Stored: args.Stored, AllowNetwork: args.AllowNetwork, Force: args.Force, Signal: ctx.ctx,
			Publish: func(publication ModelsPublication) (bool, error) {
				params := map[string]any{"publication": map[string]json.RawMessage{}}
				if publication.Persist != nil {
					params["publication"] = map[string]json.RawMessage{"persist": publication.Persist}
				}
				if publication.Update != nil {
					token := rand.Text()
					params["token"] = token
					e.providerMu.Lock()
					if e.providerUpdates == nil {
						e.providerUpdates = map[string]func() error{}
					}
					e.providerUpdates[token] = publication.Update
					e.providerMu.Unlock()
					defer func() { e.providerMu.Lock(); delete(e.providerUpdates, token); e.providerMu.Unlock() }()
				}
				return providerCallbackValue[bool](ctx, req.Tool, "publish", params)
			},
		})
	case "generateImages", "classify":
		var operation struct {
			Params struct {
				Context json.RawMessage `json:"context"`
			} `json:"params"`
		}
		if err := json.Unmarshal(req.Args, &operation); err != nil {
			return nil, err
		}
		options := ProviderOperationOptions{Signal: ctx.ctx, Values: args.Options}
		if request.Method == "generateImages" {
			if provider.GenerateImages == nil {
				return nil, errors.New("Provider has no generateImages")
			}
			var input map[string]any
			if err := json.Unmarshal(operation.Params.Context, &input); err != nil {
				return nil, err
			}
			return provider.GenerateImages(args.Model, input, options)
		}
		if provider.Classify == nil {
			return nil, errors.New("Provider has no classify")
		}
		var input ClassifierContext
		if err := json.Unmarshal(operation.Params.Context, &input); err != nil {
			return nil, err
		}
		return classifyResult(provider.Classify(args.Model, input, options))
	case "stream", "streamSimple", "fetchDeferred", "cancelDeferred":
		options := ProviderStreamOptions{Values: args.Options, Signal: ctx.ctx}
		if args.Aborted {
			signal, cancel := context.WithCancel(ctx.ctx)
			cancel()
			options.Signal = signal
		}
		if slices.Contains(args.Callbacks, "onPayload") {
			options.OnPayload = func(value any, model map[string]any) (any, error) {
				return providerCallbackValue[any](ctx, req.Tool, "onPayload", map[string]any{"value": value, "model": model})
			}
		}
		if slices.Contains(args.Callbacks, "onResponse") {
			options.OnResponse = func(value, model map[string]any) error {
				_, err := providerCallbackValue[any](ctx, req.Tool, "onResponse", map[string]any{"value": value, "model": model})
				return err
			}
		}
		if slices.Contains(args.Callbacks, "onProviderStreamEvent") {
			options.OnProviderStreamEvent = func(value any, model map[string]any) error {
				_, err := providerCallbackValue[any](ctx, req.Tool, "onProviderStreamEvent", map[string]any{"value": value, "model": model})
				return err
			}
		}
		if slices.Contains(args.Callbacks, "transformHeaders") {
			options.TransformHeaders = func(value map[string]string) (map[string]string, error) {
				return providerCallbackValue[map[string]string](ctx, req.Tool, "transformHeaders", map[string]any{"value": value})
			}
		}
		if request.Method == "cancelDeferred" {
			return nil, provider.CancelDeferred(args.Model, args.Handle, options)
		}
		method := provider.Stream
		transcript := args.Context
		if request.Method == "streamSimple" {
			method = provider.StreamSimple
		}
		if request.Method == "fetchDeferred" {
			method = provider.FetchDeferred
			transcript = args.Handle
		}
		stream, err := method(args.Model, transcript, options)
		if err != nil {
			return nil, err
		}
		if stream == nil {
			return nil, errors.New("Provider returned no stream")
		}
		if err := e.conn.notify("tool_update", map[string]any{"request_id": ctx.requestID, "result": map[string]string{"type": "provider_started"}}); err != nil {
			return nil, err
		}
		for event := range stream.Events(e.runCtx) {
			if err := e.conn.notify("tool_update", map[string]any{"request_id": ctx.requestID, "result": event}); err != nil {
				return nil, err
			}
		}
		return nil, nil
	default:
		return nil, fmt.Errorf("Unknown Provider method %s", request.Method)
	}
}
