package sdk

// Ports packages/coding-agent/src/core/model-registry.ts (findOfType, getModelsOfType, getAvailableOfType, getModelOfType, classify, generateImages, registerVirtualModel, unregisterVirtualModel) and the image and classifier implementations of packages/coding-agent/src/core/extensions/types.ts (ProviderConfig.images, ProviderConfig.classifiers).

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"time"

	"github.com/MichaelKinsy/PiG/extensions/sdk/json"
)

// ModelType is what a model is for: "chat", "image" or "classifier" (upstream ModelType).
type ModelType string

// The model types of upstream's ModelType union.
const (
	ModelTypeChat       ModelType = "chat"
	ModelTypeImage      ModelType = "image"
	ModelTypeClassifier ModelType = "classifier"
)

// OrderedObject is a JSON object that keeps its key order, as a JavaScript object does. A repeated key keeps the position of its first occurrence and the value of its last.
type OrderedObject struct {
	keys   []string
	values map[string]any
}

// NewOrderedObject builds the object from alternating string keys and values. It panics on a key that is not a string or a key without a value.
func NewOrderedObject(pairs ...any) *OrderedObject {
	if len(pairs)%2 != 0 {
		panic("NewOrderedObject requires alternating keys and values")
	}
	o := &OrderedObject{values: make(map[string]any, len(pairs)/2)}
	for i := 0; i < len(pairs); i += 2 {
		key, ok := pairs[i].(string)
		if !ok {
			panic(fmt.Sprintf("NewOrderedObject key %d is %T, not a string", i/2, pairs[i]))
		}
		o.set(key, pairs[i+1])
	}
	return o
}

func (o *OrderedObject) set(key string, value any) {
	if o.values == nil {
		o.values = map[string]any{}
	}
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// Keys returns the keys in order.
func (o *OrderedObject) Keys() []string {
	if o == nil {
		return []string{}
	}
	return slices.Clone(o.keys)
}

// Get returns the value of key.
func (o *OrderedObject) Get(key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	value, ok := o.values[key]
	return value, ok
}

// MarshalJSON writes the object with its keys in order.
func (o *OrderedObject) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('{')
	if o != nil {
		for i, key := range o.keys {
			if i > 0 {
				out.WriteByte(',')
			}
			encodedKey, err := json.Marshal(key)
			if err != nil {
				return nil, err
			}
			encodedValue, err := json.Marshal(o.values[key])
			if err != nil {
				return nil, err
			}
			out.Write(encodedKey)
			out.WriteByte(':')
			out.Write(encodedValue)
		}
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// UnmarshalJSON reads an object, keeping the order of its keys.
func (o *OrderedObject) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		if token == nil {
			*o = OrderedObject{}
			return nil
		}
		return errors.New("not a JSON object")
	}
	read := OrderedObject{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := keyToken.(string)
		if !ok {
			return errors.New("invalid JSON object key")
		}
		var value any
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		read.set(key, value)
	}
	if _, err := decoder.Token(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	*o = read
	return nil
}

// ClassifierContext is the input of a classification: the state to judge and the named questions to answer about it, in order.
type ClassifierContext struct {
	State     map[string]any `json:"state"`
	Questions *OrderedObject `json:"questions"`
}

// ClassifierOptions are the serializable options of a classification. The request's cancellation is the caller's Context.
type ClassifierOptions struct {
	APIKey          *string            `json:"apiKey,omitempty"`
	Headers         map[string]*string `json:"headers,omitempty"`
	Env             map[string]string  `json:"env,omitempty"`
	TimeoutMs       *int               `json:"timeoutMs,omitempty"`
	MaxRetries      *int               `json:"maxRetries,omitempty"`
	MaxRetryDelayMs *int               `json:"maxRetryDelayMs,omitempty"`
	Temperature     *float64           `json:"temperature,omitempty"`
}

// ClassifierResult is the final result of a classification. A failure is a result with StopReason "error" or "aborted".
type ClassifierResult struct {
	API          string         `json:"api"`
	Provider     string         `json:"provider"`
	Model        string         `json:"model"`
	Answers      *OrderedObject `json:"answers"`
	Usage        map[string]any `json:"usage,omitempty"`
	StopReason   string         `json:"stopReason"`
	ErrorMessage string         `json:"errorMessage,omitempty"`
	Timestamp    int64          `json:"timestamp"`
}

// ProviderOperationOptions are what a provider's image or classifier implementation receives besides the model and the request: the resolved request options, and the request's cancellation.
type ProviderOperationOptions struct {
	Signal context.Context
	Values map[string]any
}

// ProviderImagesFunc generates images for one image API. model, request and the result are the Pi objects as JSON maps.
type ProviderImagesFunc func(model, request map[string]any, options ProviderOperationOptions) (map[string]any, error)

// ProviderClassifyFunc classifies for one classifier API.
type ProviderClassifyFunc func(model map[string]any, request ClassifierContext, options ProviderOperationOptions) (ClassifierResult, error)

// modelTypeOf is the type of a model entry of the registry state; an entry without one is a chat model.
func modelTypeOf(model map[string]any) ModelType {
	if modelType, _ := model["type"].(string); modelType != "" {
		return ModelType(modelType)
	}
	return ModelTypeChat
}

// GetModelsOfType lists every known model of a type, optionally for one provider. Chat models come from the registry state's models and the others from its typed models, in the host's order (model-registry.ts:145-161).
func (r ModelRegistry) GetModelsOfType(modelType ModelType, provider ...string) ([]map[string]any, error) {
	state, err := r.state()
	if err != nil {
		return nil, err
	}
	models := []map[string]any{}
	for _, list := range [][]map[string]any{state.Models, state.TypedModels} {
		for _, model := range list {
			if modelTypeOf(model) != modelType {
				continue
			}
			if len(provider) > 0 && model["provider"] != provider[0] {
				continue
			}
			models = append(models, model)
		}
	}
	return models, nil
}

// GetModelOfType looks up one model of a type, or returns nil.
func (r ModelRegistry) GetModelOfType(modelType ModelType, provider, modelID string) (map[string]any, error) {
	models, err := r.GetModelsOfType(modelType, provider)
	if err != nil {
		return nil, err
	}
	for _, model := range models {
		if model["id"] == modelID {
			return model, nil
		}
	}
	return nil, nil
}

// FindOfType finds a model of a type, for example FindOfType(ModelTypeClassifier, "typesafe", "jev-latest").
func (r ModelRegistry) FindOfType(modelType ModelType, provider, modelID string) (map[string]any, error) {
	return r.GetModelOfType(modelType, provider, modelID)
}

// GetAvailableOfType lists the models of a type whose provider has working credentials. It awaits the host (model-registry.ts:135-143).
func (r ModelRegistry) GetAvailableOfType(modelType ModelType, provider ...string) ([]map[string]any, error) {
	args := struct {
		Type     ModelType `json:"type"`
		Provider string    `json:"provider,omitempty"`
	}{Type: modelType}
	if len(provider) > 0 {
		args.Provider = provider[0]
	}
	return hostValue[[]map[string]any](r.context, "getAvailableOfType", args)
}

// Classify classifies structured state with request-time authentication. It never fails: a failure, and a cancelled request, are a result with StopReason "error" or "aborted" that names the model (model-registry.ts:170-177).
func (r ModelRegistry) Classify(model map[string]any, request ClassifierContext, options *ClassifierOptions) ClassifierResult {
	args := struct {
		Model   map[string]any     `json:"model"`
		Context ClassifierContext  `json:"context"`
		Options *ClassifierOptions `json:"options,omitempty"`
	}{model, request, options}
	result, err := hostValue[ClassifierResult](r.context, "classify", args)
	if err != nil {
		return classifierErrorResult(model, err, r.context.ctx != nil && r.context.ctx.Err() != nil)
	}
	if result.Answers == nil {
		result.Answers = NewOrderedObject()
	}
	return result
}

func classifierErrorResult(model map[string]any, err error, aborted bool) ClassifierResult {
	api, _ := model["api"].(string)
	provider, _ := model["provider"].(string)
	id, _ := model["id"].(string)
	stop := "error"
	if aborted {
		stop = "aborted"
	}
	return ClassifierResult{API: api, Provider: provider, Model: id, Answers: NewOrderedObject(), StopReason: stop, ErrorMessage: err.Error(), Timestamp: time.Now().UnixMilli()}
}

// ImagesOptions are the serializable options of an image generation. The request's cancellation is the caller's Context.
type ImagesOptions struct {
	APIKey          *string            `json:"apiKey,omitempty"`
	Headers         map[string]*string `json:"headers,omitempty"`
	Env             map[string]string  `json:"env,omitempty"`
	TimeoutMs       *int               `json:"timeoutMs,omitempty"`
	MaxRetries      *int               `json:"maxRetries,omitempty"`
	MaxRetryDelayMs *int               `json:"maxRetryDelayMs,omitempty"`
	Metadata        map[string]any     `json:"metadata,omitempty"`
}

// GenerateImages generates images with request-time authentication. request is the images context ({"input": [...]}) and the result is Pi's AssistantImages object, both as JSON maps. It never fails: a failure, and a cancelled request, are a result with "stopReason" "error" or "aborted" that names the model (model-registry.ts:181-188).
func (r ModelRegistry) GenerateImages(model map[string]any, request map[string]any, options *ImagesOptions) map[string]any {
	args := struct {
		Model   map[string]any `json:"model"`
		Context map[string]any `json:"context"`
		Options *ImagesOptions `json:"options,omitempty"`
	}{model, request, options}
	result, err := hostValue[map[string]any](r.context, "generateImages", args)
	if err != nil {
		return imageErrorResult(model, err, r.context.ctx != nil && r.context.ctx.Err() != nil)
	}
	return result
}

// imageErrorResult is upstream imageErrorResult (model-operations.ts:44-54).
func imageErrorResult(model map[string]any, err error, aborted bool) map[string]any {
	stop := "error"
	if aborted {
		stop = "aborted"
	}
	return map[string]any{"api": model["api"], "provider": model["provider"], "model": model["id"], "output": []any{}, "stopReason": stop, "errorMessage": err.Error(), "timestamp": time.Now().UnixMilli()}
}

// RegisterVirtualModel registers a virtual model; see [Context.RegisterVirtualModel].
func (r ModelRegistry) RegisterVirtualModel(model VirtualModel) error {
	return r.context.RegisterVirtualModel(model)
}

// UnregisterVirtualModel removes a virtual model; see [Context.UnregisterVirtualModel].
func (r ModelRegistry) UnregisterVirtualModel(provider, id string) {
	r.context.UnregisterVirtualModel(provider, id)
}

// providerOperations are the image and classifier implementations of one provider config, by API.
type providerOperations struct {
	images      map[string]ProviderImagesFunc
	classifiers map[string]ProviderClassifyFunc
}

// takeProviderOperations removes the images and classifiers callbacks of a provider config, which cannot cross the wire, and returns them with the API names the register payload declares. It panics on a value of another type, as it does for streamSimple.
func takeProviderOperations(config ProviderConfig) (providerOperations, []string, []string) {
	var ops providerOperations
	if raw, exists := config["images"]; exists {
		images, ok := raw.(map[string]ProviderImagesFunc)
		if !ok {
			panic("provider images has an invalid Go callback signature")
		}
		ops.images = images
		delete(config, "images")
	}
	if raw, exists := config["classifiers"]; exists {
		classifiers, ok := raw.(map[string]ProviderClassifyFunc)
		if !ok {
			panic("provider classifiers has an invalid Go callback signature")
		}
		ops.classifiers = classifiers
		delete(config, "classifiers")
	}
	imageAPIs, classifierAPIs := []string{}, []string{}
	for api, callback := range ops.images {
		if callback != nil {
			imageAPIs = append(imageAPIs, api)
		}
	}
	for api, callback := range ops.classifiers {
		if callback != nil {
			classifierAPIs = append(classifierAPIs, api)
		}
	}
	slices.Sort(imageAPIs)
	slices.Sort(classifierAPIs)
	return ops, imageAPIs, classifierAPIs
}

// dispatchProviderOperation runs the image or classifier implementation of a provider config that a provider_operation request names. An error is the request's error (types.ts:1896-1898).
func (e *Extension) dispatchProviderOperation(ctx Context, req *requestMsg) (any, error) {
	var request struct {
		Kind    string          `json:"kind"`
		API     string          `json:"api"`
		Model   map[string]any  `json:"model"`
		Context json.RawMessage `json:"context"`
		Options map[string]any  `json:"options"`
	}
	if err := json.Unmarshal(req.Args, &request); err != nil {
		return nil, err
	}
	e.providerMu.RLock()
	ops := e.providerOperations[req.Tool]
	e.providerMu.RUnlock()
	options := ProviderOperationOptions{Signal: ctx.ctx, Values: request.Options}
	switch request.Kind {
	case "images":
		callback := ops.images[request.API]
		if callback == nil {
			return nil, fmt.Errorf("Provider %s has no image implementation for %q", req.Tool, request.API)
		}
		var input map[string]any
		if err := json.Unmarshal(request.Context, &input); err != nil {
			return nil, err
		}
		return callback(request.Model, input, options)
	case "classifiers":
		callback := ops.classifiers[request.API]
		if callback == nil {
			return nil, fmt.Errorf("Provider %s has no classifier implementation for %q", req.Tool, request.API)
		}
		var input ClassifierContext
		if err := json.Unmarshal(request.Context, &input); err != nil {
			return nil, err
		}
		return classifyResult(callback(request.Model, input, options))
	}
	return nil, fmt.Errorf("Unknown provider operation %q", request.Kind)
}

// classifyResult gives a result without answers an empty answers object, as a result always carries one.
func classifyResult(result ClassifierResult, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	if result.Answers == nil {
		result.Answers = NewOrderedObject()
	}
	return result, nil
}
