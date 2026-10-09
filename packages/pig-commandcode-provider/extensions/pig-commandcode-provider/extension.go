package commandcode

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func configured(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// Extension is PiG's Go factory. No Node process or TypeScript registration is involved.
func Extension() *sdk.Extension {
	ext := sdk.New("pig-commandcode-provider")
	lifetime, cancel := context.WithCancel(context.Background())
	base := configured("COMMANDCODE_API_BASE", defaultBase)
	home, _ := os.UserHomeDir()
	agentDir := configured("PIG_CODING_AGENT_DIR", configured("PI_CODING_AGENT_DIR", filepath.Join(home, ".pig", "agent")))
	timeout := 10 * time.Second
	if milliseconds, err := strconv.Atoi(os.Getenv("COMMANDCODE_MODELS_TIMEOUT_MS")); err == nil && milliseconds > 0 {
		timeout = time.Duration(milliseconds) * time.Millisecond
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// Never redirect a request bearing a provider key to a different endpoint.
	client := &http.Client{Transport: transport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	store := &modelStore{base: base, endpoint: configured("COMMANDCODE_MODELS_URL", defaultBase+"/models"), cachePath: configured("COMMANDCODE_MODELS_CACHE", filepath.Join(agentDir, "commandcode-models.json")), timeout: timeout, client: client}
	store.models = store.readCache()
	store.source = "empty"
	if len(store.models) > 0 {
		store.source = "cache"
	} else {
		_ = store.refresh(lifetime)
	}
	router := &transportRouter{base: base, client: client}
	provider := &sdk.Provider{ID: providerID, Name: "Command Code", BaseURL: &base, GetModels: store.get, Stream: router.stream, StreamSimple: router.stream}
	provider.Auth.APIKey = keyAuth(base, client)
	provider.Auth.OAuth = oauthAuth(provider.Auth.APIKey)
	if os.Getenv("CMD_ZDR") == "1" || os.Getenv("COMMANDCODE_ZDR") == "1" {
		provider.Headers = map[string]string{"x-cmd-zdr": "1"}
		router.headers = provider.Headers
	}
	provider.RefreshModels = func(input sdk.RefreshModelsContext) error {
		if !input.AllowNetwork {
			return nil
		}
		ctx := input.Signal
		if ctx == nil {
			ctx = context.Background()
		}
		ctx, stop := context.WithCancel(ctx)
		stopLifetime := context.AfterFunc(lifetime, stop)
		defer func() { stopLifetime(); stop() }()
		err := store.refresh(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if input.Publish != nil {
			if _, publishErr := input.Publish(sdk.ModelsPublication{}); publishErr != nil {
				return publishErr
			}
		}
		// Usable cached models survive a failed network refresh.
		models, _ := store.get()
		if len(models) == 0 {
			return err
		}
		return nil
	}
	if err := ext.RegisterNativeProvider(provider); err != nil {
		panic("register Command Code: " + err.Error())
	}
	// Cached models are immediately usable. Refresh and publish them in the
	// background after registration, using the public retained SDK context.
	ext.OnSessionStart(func(ctx sdk.Context, _ map[string]any) (any, error) {
		store.mu.Lock()
		cached := store.source == "cache"
		store.mu.Unlock()
		if cached {
			go func() {
				allow := true
				_, _ = ctx.ModelRegistry().Refresh(sdk.ModelsRefreshOptions{AllowNetwork: &allow, Providers: []string{providerID}})
			}()
		}
		return nil, nil
	})
	ext.Command("commandcode-status", "Show Command Code catalog and transport status", func(ctx sdk.Context, _ string) error {
		store.mu.Lock()
		source, count, warning := store.source, len(store.models), store.warning
		store.mu.Unlock()
		lines := []string{fmt.Sprintf("Command Code: %d models (%s)", count, source), "Transport: " + router.status()}
		if warning != "" {
			lines = append(lines, warning)
		}
		ctx.Notify(strings.Join(lines, "\n"), "info")
		return nil
	})
	ext.Command("commandcode-refresh", "Refresh Command Code models", func(ctx sdk.Context, _ string) error {
		allow, force := true, true
		result, err := ctx.ModelRegistry().Refresh(sdk.ModelsRefreshOptions{AllowNetwork: &allow, Force: &force, Providers: []string{providerID}})
		if err != nil {
			return err
		}
		if result.Aborted {
			return nil
		}
		if len(result.Errors) > 0 {
			ctx.Notify("Could not refresh Command Code models; previous catalog retained", "warning")
		} else {
			models, _ := store.get()
			ctx.Notify(fmt.Sprintf("Command Code: %d models", len(models)), "info")
		}
		return nil
	})
	ext.Command("commandcode-quota", "Show Command Code quota and subscription", func(ctx sdk.Context, _ string) error {
		auth, err := ctx.ModelRegistry().GetProviderAuth(providerID)
		if err != nil {
			return err
		}
		credentials, _ := auth["auth"].(map[string]any)
		key := credentialKey(credentials)
		text, err := fetchQuota(lifetime, client, base, key, provider.Headers)
		if err != nil {
			ctx.Notify(safeError(err.Error(), key), "warning")
			return nil
		}
		ctx.Notify(text, "info")
		return nil
	})
	ext.OnSessionShutdown(func(_ sdk.Context, _ map[string]any) (any, error) {
		cancel()
		transport.CloseIdleConnections()
		return nil, nil
	})
	return ext
}
