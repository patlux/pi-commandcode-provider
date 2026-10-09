package commandcode

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MichaelKinsy/PiG/ai"
	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func TestCanceledAuthDoesNotPromptNotifyOrRefresh(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	prompts, notices := 0, 0
	input := sdk.AuthInteraction{Signal: ctx, Prompt: func(map[string]any) (string, error) { prompts++; return "browser", nil }, Notify: func(map[string]any) error { notices++; return nil }}
	key := keyAuth("http://127.0.0.1:1/provider/v1", &http.Client{Timeout: time.Second})
	for name, login := range map[string]func(sdk.AuthInteraction) (map[string]any, error){"key": key.Login, "oauth": oauthAuth(key).Login} {
		t.Run(name, func(t *testing.T) {
			credential, err := login(input)
			if !errors.Is(err, context.Canceled) || credential != nil {
				t.Errorf("cancellation lost: credential=%v err=%v", credential != nil, err)
			}
		})
	}
	if prompts != 0 || notices != 0 {
		t.Errorf("canceled login started interaction: prompts=%d notices=%d", prompts, notices)
	}
	credential, err := oauthAuth(key).Refresh(map[string]any{"refresh": "synthetic"}, ctx)
	if !errors.Is(err, context.Canceled) || credential != nil {
		t.Error("canceled refresh issued a credential")
	}
}

func TestLoginCancellationAfterPromptDoesNotStartIO(t *testing.T) {
	for _, name := range []string{"key", "oauth"} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			requests, notices := 0, 0
			client := &http.Client{Transport: ai.FetchFunction(func(*http.Request) (*http.Response, error) {
				requests++
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
			})}
			key := keyAuth(defaultBase, client)
			login := key.Login
			if name == "oauth" {
				login = oauthAuth(key).Login
			}
			credential, err := login(sdk.AuthInteraction{Signal: ctx, Prompt: func(map[string]any) (string, error) {
				cancel()
				return "browser", nil
			}, Notify: func(map[string]any) error { notices++; return nil }})
			if !errors.Is(err, context.Canceled) || credential != nil || requests != 0 || notices != 0 {
				t.Fatalf("canceled prompt started I/O: err=%v requests=%d notices=%d", err, requests, notices)
			}
		})
	}
}

func TestAPIKeyLoginRejectsPlaceholderWithoutRequest(t *testing.T) {
	requests := 0
	client := &http.Client{Transport: ai.FetchFunction(func(*http.Request) (*http.Response, error) {
		requests++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	credential, err := keyAuth(defaultBase, client).Login(sdk.AuthInteraction{Prompt: func(map[string]any) (string, error) { return " $COMMAND_CODE_API_KEY ", nil }})
	if err == nil || credential != nil || requests != 0 {
		t.Fatal("placeholder was sent or accepted as a credential")
	}
}

func TestAPIKeyLoginCancellationClosesValidationRequest(t *testing.T) {
	entered, closed := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(closed)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := keyAuth(server.URL+"/provider/v1", server.Client()).Login(sdk.AuthInteraction{Signal: ctx, Prompt: func(map[string]any) (string, error) { return "synthetic", nil }})
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("validation request did not start")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("validation masked caller cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("login did not cancel")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("validation request stayed connected")
	}
}

func TestAPIKeyLoginCannotSucceedAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := &http.Client{Transport: ai.FetchFunction(func(*http.Request) (*http.Response, error) {
		cancel()
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})}
	credential, err := keyAuth(defaultBase, client).Login(sdk.AuthInteraction{Signal: ctx, Prompt: func(map[string]any) (string, error) { return "synthetic", nil }})
	if !errors.Is(err, context.Canceled) || credential != nil {
		t.Fatal("login returned a credential after caller cancellation")
	}
}

func TestCallbackRejectsInvalidKeysAndWholeDocuments(t *testing.T) {
	server, err := startCallback("expected", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer server.close()
	client := &http.Client{Timeout: time.Second}
	valid := authCallback{State: "expected", APIKey: "synthetic", UserID: "user", UserName: "test", KeyName: "test"}
	encoded, _ := json.Marshal(valid)
	post := func(body string) int {
		res, err := client.Post(server.url(), "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		io.Copy(io.Discard, res.Body)
		return res.StatusCode
	}
	for _, key := range []string{" ", "\n\t", "\x1b[200~\x1b[201~", "$COMMAND_CODE_API_KEY"} {
		invalid := valid
		invalid.APIKey = key
		body, _ := json.Marshal(invalid)
		if status := post(string(body)); status != http.StatusBadRequest {
			t.Errorf("invalid sanitized key accepted: HTTP %d", status)
		}
	}
	for _, suffix := range []string{"{}", "broken", strings.Repeat(" ", 10000)} {
		if status := post(string(encoded) + suffix); status != http.StatusBadRequest {
			t.Errorf("invalid full callback body accepted: HTTP %d", status)
		}
	}
	select {
	case <-server.result:
		t.Error("invalid callback consumed the one-shot login")
	default:
	}
	if status := post(string(encoded)); status != http.StatusOK {
		t.Errorf("valid callback after invalid attempts failed: HTTP %d", status)
	}
}

func TestOAuthCancellationWinsOverBufferedCallback(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var callbackURL string
	var validations atomic.Int32
	client := &http.Client{Timeout: time.Second}
	credential, err := oauthAuth(&sdk.APIKeyAuth{Login: func(sdk.AuthInteraction) (map[string]any, error) {
		validations.Add(1)
		return nil, errors.New("unexpected manual login")
	}}).Login(sdk.AuthInteraction{
		Signal: ctx,
		Prompt: func(map[string]any) (string, error) { return "browser", nil },
		Notify: func(event map[string]any) error {
			link, err := url.Parse(stringField(event, "url"))
			if err != nil {
				return err
			}
			callbackURL = link.Query().Get("callback")
			body, _ := json.Marshal(authCallback{State: link.Query().Get("state"), APIKey: "synthetic", UserID: "user", UserName: "test", KeyName: "test"})
			res, err := client.Post(callbackURL, "application/json", strings.NewReader(string(body)))
			if err != nil {
				return err
			}
			res.Body.Close()
			cancel()
			return nil
		},
	})
	if !errors.Is(err, context.Canceled) || credential != nil || validations.Load() != 0 {
		t.Error("buffered callback won over completed caller cancellation")
	}
	if res, err := client.Get(callbackURL); err == nil {
		res.Body.Close()
		t.Fatal("callback listener survived cancellation")
	}
}
