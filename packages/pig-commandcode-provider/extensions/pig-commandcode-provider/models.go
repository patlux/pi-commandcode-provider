package commandcode

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

const providerID = "commandcode"
const customAPI = "commandcode-custom"
const defaultBase = "https://api.commandcode.ai/provider/v1"

// Generated from the existing TypeScript catalog, overrides and reviewed prices.
//
//go:embed catalog.json
var catalogJSON []byte

type modelMetadata struct {
	Input     []string       `json:"input"`
	Reasoning bool           `json:"reasoning"`
	Efforts   []string       `json:"efforts"`
	MaxTokens int            `json:"maxTokens"`
	Cost      map[string]any `json:"cost"`
}
type catalogSnapshot struct {
	CLIVersion string                   `json:"cliVersion"`
	Models     map[string]modelMetadata `json:"models"`
}

var catalog = func() catalogSnapshot {
	var value catalogSnapshot
	if err := json.Unmarshal(catalogJSON, &value); err != nil {
		panic("invalid embedded catalog: " + err.Error())
	}
	return value
}()

type modelEntry struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ContextWindow int    `json:"contextWindow"`
	MaxTokens     int    `json:"maxTokens"`
	Reasoning     bool   `json:"reasoning"`
}

func (entry modelEntry) wire(base string) map[string]any {
	meta, known := catalog.Models[entry.ID]
	if !known {
		meta.Input = []string{"text"}
		meta.MaxTokens = 65536
		meta.Cost = map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
	}
	compat := map[string]any{"supportsStore": false, "supportsDeveloperRole": false, "supportsReasoningEffort": len(meta.Efforts) > 0, "maxTokensField": "max_tokens"}
	base = strings.TrimRight(base, "/")
	if strings.HasPrefix(entry.ID, "claude-") {
		base = strings.TrimSuffix(base, "/v1")
		compat = map[string]any{"supportsEagerToolInputStreaming": false, "supportsLongCacheRetention": false, "supportsCacheControlOnTools": false, "supportsToolReferences": false}
		if meta.Reasoning {
			compat["forceAdaptiveThinking"] = true
		}
	}
	result := map[string]any{"id": entry.ID, "name": entry.Name, "provider": providerID, "api": customAPI, "baseUrl": base, "input": slices.Clone(meta.Input), "reasoning": meta.Reasoning, "cost": cloneJSON(meta.Cost), "contextWindow": entry.ContextWindow, "maxTokens": min(entry.ContextWindow, meta.MaxTokens), "compat": compat}
	if meta.Reasoning || len(meta.Efforts) > 0 {
		levels := map[string]any{"minimal": nil, "low": nil, "medium": nil, "high": nil, "xhigh": nil, "max": nil}
		for _, effort := range meta.Efforts {
			levels[effort] = effort
		}
		result["thinkingLevelMap"] = levels
	}
	return result
}

type modelStore struct {
	mu                        sync.Mutex
	models                    []modelEntry
	source                    string
	warning                   string
	loading                   *modelRefresh
	endpoint, cachePath, base string
	timeout                   time.Duration
	client                    *http.Client
}

func validateModels(models []modelEntry) error {
	if len(models) == 0 {
		return errors.New("empty model catalog")
	}
	seen := map[string]bool{}
	for _, model := range models {
		if strings.TrimSpace(model.ID) == "" || strings.TrimSpace(model.Name) == "" || model.ContextWindow <= 0 || seen[model.ID] {
			return errors.New("invalid or duplicate model entry")
		}
		seen[model.ID] = true
	}
	return nil
}

func (s *modelStore) readCache() []modelEntry {
	file, err := os.Open(s.cachePath)
	if err != nil {
		return nil
	}
	defer file.Close()
	var cache struct {
		Version int          `json:"version"`
		Models  []modelEntry `json:"models"`
	}
	if readJSONDocument(file, 4<<20, &cache) != nil || cache.Version != 1 || validateModels(cache.Models) != nil {
		return nil
	}
	return cache.Models
}

func (s *modelStore) writeCache(models []modelEntry) error {
	data, err := json.Marshal(struct {
		Version int          `json:"version"`
		Models  []modelEntry `json:"models"`
	}{1, models})
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(s.cachePath), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(s.cachePath), ".commandcode-models-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(append(data, '\n')); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), s.cachePath)
}

func (s *modelStore) fetch(ctx context.Context) ([]modelEntry, error) {
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("model catalog HTTP %d", res.StatusCode)
	}
	var body struct {
		Object string `json:"object"`
		Data   []struct {
			ID            string `json:"id"`
			Name          string `json:"name"`
			ContextLength int    `json:"context_length"`
		} `json:"data"`
	}
	if err = readJSONDocument(res.Body, 4<<20, &body); err != nil {
		return nil, errors.New("invalid model catalog JSON")
	}
	if body.Object != "list" {
		return nil, errors.New("expected model catalog list")
	}
	models := make([]modelEntry, 0, len(body.Data))
	for _, value := range body.Data {
		if strings.TrimSpace(value.Name) == "" {
			return nil, errors.New("missing model name")
		}
		meta, known := catalog.Models[value.ID]
		limit := 65536
		if known {
			limit = meta.MaxTokens
		}
		models = append(models, modelEntry{value.ID, value.Name + " (CC)", value.ContextLength, min(value.ContextLength, limit), meta.Reasoning})
	}
	return models, validateModels(models)
}

type modelRefresh struct {
	done chan struct{}
	err  error
}

func cloneJSON(value any) any {
	switch value := value.(type) {
	case map[string]any:
		copy := make(map[string]any, len(value))
		for key, item := range value {
			copy[key] = cloneJSON(item)
		}
		return copy
	case []any:
		copy := make([]any, len(value))
		for index, item := range value {
			copy[index] = cloneJSON(item)
		}
		return copy
	default:
		return value
	}
}

// Concurrent refresh callers share one request and its error; cancellation never overwrites good state.
func (s *modelStore) refresh(ctx context.Context) (refreshErr error) {
	s.mu.Lock()
	if pending := s.loading; pending != nil {
		s.mu.Unlock()
		select {
		case <-pending.done:
			return pending.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	pending := &modelRefresh{done: make(chan struct{})}
	s.loading = pending
	s.mu.Unlock()
	defer func() { s.mu.Lock(); pending.err = refreshErr; close(pending.done); s.loading = nil; s.mu.Unlock() }()
	models, err := s.fetch(ctx)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	source, warning := "live", ""
	if err != nil {
		models = s.readCache()
		source = "cache"
		warning = "Could not refresh Command Code model catalog; using cached catalog"
		if len(models) == 0 {
			source = "empty"
			warning = "Command Code models unavailable; run /commandcode-refresh"
		}
	} else if s.writeCache(models) != nil {
		warning = "Loaded live catalog but could not update model cache"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Disk may be older than memory (a cache write can fail or a different
	// process can replace the file). Only a successful live fetch replaces an
	// already usable catalog; disk fallback is for cold/empty state.
	if err != nil && len(s.models) > 0 {
		s.warning = "Could not refresh Command Code model catalog; current catalog retained"
		return err
	}
	s.models, s.source, s.warning = models, source, warning
	return err
}

func (s *modelStore) get() ([]map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	models := make([]map[string]any, 0, len(s.models))
	for _, model := range s.models {
		models = append(models, model.wire(s.base))
	}
	return models, nil
}
