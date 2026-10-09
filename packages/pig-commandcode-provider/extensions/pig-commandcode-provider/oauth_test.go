package commandcode

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func TestCallbackRejectsBadStateOriginAndDuplicate(t *testing.T) {
	server, err := startCallback("expected", 0)
	if err != nil {
		t.Fatal(err)
	}
	defer server.close()
	client := &http.Client{Timeout: time.Second}
	post := func(state, origin string) int {
		body, _ := json.Marshal(authCallback{State: state, APIKey: "synthetic", UserID: "user", UserName: "test", KeyName: "test"})
		req, _ := http.NewRequest(http.MethodPost, server.url(), strings.NewReader(string(body)))
		req.Header.Set("Origin", origin)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		io.Copy(io.Discard, res.Body)
		return res.StatusCode
	}
	if post("wrong", "https://commandcode.ai") != 403 {
		t.Fatal("accepted wrong state")
	}
	if post("expected", "https://evil.invalid") != 403 {
		t.Fatal("accepted foreign origin")
	}
	if post("expected", "https://commandcode.ai") != 200 {
		t.Fatal("rejected valid callback")
	}
	if post("expected", "https://commandcode.ai") != 409 {
		t.Fatal("accepted duplicate callback")
	}
	if callback := <-server.result; callback.APIKey != "synthetic" {
		t.Fatal("wrong callback")
	}
}

func TestOAuthBrowserFlowWithSyntheticCallbackClosesListener(t *testing.T) {
	var callbackURL string
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	credential, err := oauthAuth(keyAuth(defaultBase, http.DefaultClient)).Login(sdk.AuthInteraction{
		Signal: ctx,
		Prompt: func(map[string]any) (string, error) { return "browser", nil },
		Notify: func(event map[string]any) error {
			link, err := url.Parse(stringField(event, "url"))
			if err != nil {
				return err
			}
			if link.Host != "commandcode.ai" || event["type"] != "auth_url" {
				t.Fatal("wrong login notification")
			}
			callbackURL = link.Query().Get("callback")
			body, _ := json.Marshal(authCallback{State: link.Query().Get("state"), APIKey: "synthetic-browser-key", UserID: "user", UserName: "test", KeyName: "test"})
			res, err := http.Post(callbackURL, "application/json", strings.NewReader(string(body)))
			if err != nil {
				return err
			}
			res.Body.Close()
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if credential["access"] != "synthetic-browser-key" || credential["refresh"] != "synthetic-browser-key" {
		t.Fatal("incorrect browser credentials")
	}
	client := &http.Client{Timeout: time.Second}
	res, err := client.Get(callbackURL)
	if err == nil {
		res.Body.Close()
		t.Fatal("callback listener survived login")
	}
}
