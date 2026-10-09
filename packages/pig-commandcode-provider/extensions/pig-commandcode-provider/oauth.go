package commandcode

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

type authCallback struct {
	APIKey   string `json:"apiKey"`
	State    string `json:"state"`
	UserID   string `json:"userId"`
	UserName string `json:"userName"`
	KeyName  string `json:"keyName"`
	Error    string `json:"error"`
}

type callbackServer struct {
	server   *http.Server
	listener net.Listener
	result   chan authCallback
	once     sync.Once
}

func startCallback(state string, startPort int) (*callbackServer, error) {
	var listener net.Listener
	var err error
	for offset := 0; offset <= 10; offset++ {
		port := 0
		if startPort > 0 && offset < 10 {
			port = startPort + offset
		}
		listener, err = net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			break
		}
		if startPort == 0 {
			return nil, err
		}
	}
	if err != nil {
		return nil, err
	}
	callback := &callbackServer{listener: listener, result: make(chan authCallback, 1)}
	callback.server = &http.Server{ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		origin := r.Header.Get("Origin")
		if origin != "" && origin != "https://commandcode.ai" && origin != "https://staging.commandcode.ai" && origin != "http://localhost:3000" {
			http.Error(w, "origin not allowed", 403)
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		if r.URL.Path != "/callback" {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var body authCallback
		if readJSONDocument(r.Body, 10000, &body) != nil {
			http.Error(w, "invalid callback", 400)
			return
		}
		if subtle.ConstantTimeCompare([]byte(body.State), []byte(state)) != 1 {
			http.Error(w, "invalid state", 403)
			return
		}
		body.APIKey = usableKey(sanitizeKey(body.APIKey))
		if body.Error == "" && (body.APIKey == "" || strings.TrimSpace(body.UserID) == "" || strings.TrimSpace(body.UserName) == "" || strings.TrimSpace(body.KeyName) == "") {
			http.Error(w, "missing callback fields", 400)
			return
		}
		accepted := false
		callback.once.Do(func() { accepted = true; callback.result <- body })
		if !accepted {
			http.Error(w, "callback already received", 409)
			return
		}
		fmt.Fprint(w, `{"success":true}`)
	})}
	go func() { _ = callback.server.Serve(listener) }()
	return callback, nil
}
func (s *callbackServer) close() { _ = s.server.Close() }
func (s *callbackServer) url() string {
	return "http://localhost:" + fmt.Sprint(s.listener.Addr().(*net.TCPAddr).Port) + "/callback"
}

func oauthCredential(key string) map[string]any {
	return map[string]any{"type": "oauth", "access": key, "refresh": key, "expires": time.Now().Add(10 * 365 * 24 * time.Hour).UnixMilli()}
}

func oauthAuth(apiKey *sdk.APIKeyAuth) *sdk.OAuthAuth {
	return &sdk.OAuthAuth{Name: "Command Code", Login: func(input sdk.AuthInteraction) (map[string]any, error) {
		ctx := input.Signal
		if ctx == nil {
			ctx = context.Background()
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if input.Prompt == nil {
			return nil, errors.New("Command Code login requires prompt support")
		}
		value, err := input.Prompt(map[string]any{"type": "text", "message": "Command Code login: Enter for browser, 'key' to paste a key, or paste the key directly:"})
		if err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		value = sanitizeKey(value)
		manual := func(value string) (map[string]any, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			manualInput := input
			if value != "" {
				manualInput.Prompt = func(map[string]any) (string, error) { return value, nil }
			}
			credential, err := apiKey.Login(manualInput)
			if err != nil {
				return nil, err
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			return oauthCredential(credentialKey(credential)), nil
		}
		switch strings.ToLower(value) {
		case "key", "k", "2", "api", "paste":
			return manual("")
		case "", "browser", "b", "1":
		default:
			return manual(value)
		}
		if input.Notify == nil {
			return nil, errors.New("Command Code browser login requires notification support")
		}
		stateBytes := make([]byte, 32)
		if _, err = rand.Read(stateBytes); err != nil {
			return nil, err
		}
		state := hex.EncodeToString(stateBytes)
		server, err := startCallback(state, 5959)
		if err != nil {
			return manual("")
		}
		defer server.close()
		values := url.Values{"callback": []string{server.url()}, "state": []string{state}}
		if err = input.Notify(map[string]any{"type": "auth_url", "url": "https://commandcode.ai/studio/auth/cli?" + values.Encode()}); err != nil {
			return nil, err
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		timeout := time.NewTimer(120 * time.Second)
		defer timeout.Stop()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timeout.C:
			server.close()
			return manual("")
		case result := <-server.result:
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if result.Error != "" {
				return nil, errors.New("Command Code authorization was denied")
			}
			return oauthCredential(result.APIKey), nil
		}
	}, Refresh: func(credential map[string]any, ctx context.Context) (map[string]any, error) {
		if ctx != nil && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		key := usableKey(stringField(credential, "refresh"))
		if key == "" {
			return nil, errors.New("missing Command Code refresh credential")
		}
		return oauthCredential(key), nil
	}, ToAuth: func(credential map[string]any) (map[string]any, error) {
		key := usableKey(stringField(credential, "access"))
		if key == "" {
			return nil, errors.New("missing Command Code access credential")
		}
		return map[string]any{"apiKey": key}, nil
	}}
}
