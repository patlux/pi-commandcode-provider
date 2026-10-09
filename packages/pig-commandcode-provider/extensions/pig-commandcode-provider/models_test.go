package commandcode

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestModelCatalogRejectsInvalidWholeDocument(t *testing.T) {
	valid := `{"object":"list","data":[{"id":"gpt-4.1","name":"GPT","context_length":128000}]}`
	for _, test := range []struct{ name, body string }{
		{"trailing garbage", valid + "broken"},
		{"second document", valid + `{}`},
		{"oversized suffix", valid + strings.Repeat(" ", 4<<20)},
		{"blank ID", `{"object":"list","data":[{"id":"  ","name":"GPT","context_length":128000}]}`},
		{"blank name", `{"object":"list","data":[{"id":"gpt-4.1","name":"\t ","context_length":128000}]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, test.body) }))
			defer server.Close()
			store := &modelStore{endpoint: server.URL, client: server.Client(), timeout: time.Second, cachePath: filepath.Join(t.TempDir(), "catalog.json")}
			if err := store.refresh(context.Background()); err == nil {
				t.Fatal("accepted malformed/oversized catalog")
			}
			if models, _ := store.get(); len(models) != 0 {
				t.Fatal("invalid catalog published")
			}
			if _, err := os.Stat(store.cachePath); !os.IsNotExist(err) {
				t.Fatal("invalid catalog persisted")
			}
		})
	}
}

func TestModelCacheRejectsInvalidWholeDocument(t *testing.T) {
	valid := `{"version":1,"models":[{"id":"gpt-4.1","name":"GPT","contextWindow":128000}]}`
	for _, suffix := range []string{"{}", "broken", strings.Repeat(" ", 4<<20)} {
		path := filepath.Join(t.TempDir(), "catalog.json")
		if err := os.WriteFile(path, []byte(valid+suffix), 0600); err != nil {
			t.Fatal(err)
		}
		store := &modelStore{cachePath: path}
		if len(store.readCache()) != 0 {
			t.Fatal("accepted corrupt/oversized cache prefix")
		}
	}
	path := filepath.Join(t.TempDir(), "valid.json")
	if err := os.WriteFile(path, []byte(valid+"\r\n \t"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := (&modelStore{cachePath: path}).readCache(); len(got) != 1 {
		t.Fatal("valid JSON whitespace was rejected")
	}
}

func TestRefreshFailureDoesNotRollBackNewerMemoryToStaleCache(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "offline", 503) }))
	defer server.Close()
	store := &modelStore{base: defaultBase, endpoint: server.URL, client: server.Client(), timeout: time.Second, cachePath: filepath.Join(t.TempDir(), "catalog.json")}
	stale := []modelEntry{{ID: "gpt-4.1", Name: "Old", ContextWindow: 128000}}
	if err := store.writeCache(stale); err != nil {
		t.Fatal(err)
	}
	// A live refresh can succeed while its cache write fails, or another
	// process can replace the shared file. Neither authorizes a rollback.
	current := []modelEntry{{ID: "gpt-5.4", Name: "Current", ContextWindow: 200000}}
	store.models, store.source = current, "live"
	if err := store.refresh(context.Background()); err == nil {
		t.Fatal("expected network error")
	}
	if !reflect.DeepEqual(store.models, current) || store.source != "live" {
		t.Fatalf("last good catalog rolled back: %#v (%s)", store.models, store.source)
	}
	if !strings.Contains(store.warning, "retained") {
		t.Fatalf("misleading failure diagnostic: %q", store.warning)
	}
	cold := &modelStore{base: defaultBase, endpoint: server.URL, client: server.Client(), timeout: time.Second, cachePath: store.cachePath}
	if err := cold.refresh(context.Background()); err == nil {
		t.Fatal("expected network error on cold start")
	}
	if !reflect.DeepEqual(cold.models, stale) || cold.source != "cache" {
		t.Fatal("cold offline start did not use the valid disk cache")
	}
}

func TestRefreshCancellationPreservesCatalogAndCache(t *testing.T) {
	entered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
	}))
	defer server.Close()
	models := []modelEntry{{ID: "gpt-4.1", Name: "Retained", ContextWindow: 128000}}
	store := &modelStore{models: models, source: "live", warning: "unchanged", endpoint: server.URL, client: server.Client(), timeout: time.Second, cachePath: filepath.Join(t.TempDir(), "catalog.json")}
	if err := store.writeCache(models); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(store.cachePath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- store.refresh(ctx) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("no catalog request")
	}
	cancel()
	select {
	case err := <-result:
		if err != context.Canceled {
			t.Fatalf("cancellation lost: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled refresh did not terminate")
	}
	after, err := os.ReadFile(store.cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(store.models, models) || store.source != "live" || store.warning != "unchanged" || string(before) != string(after) {
		t.Fatal("cancellation mutated last good catalog")
	}
}
