package commandcode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	sdk "github.com/MichaelKinsy/PiG/extensions/sdk"
)

func usableKey(value string) string {
	value = strings.TrimSpace(value)
	switch value {
	case "", "COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY", "$COMMAND_CODE_API_KEY", "$COMMANDCODE_API_KEY":
		return ""
	}
	return value
}

func credentialKey(credential map[string]any) string {
	for _, name := range []string{"apiKey", "key", "access"} {
		if key := usableKey(stringField(credential, name)); key != "" {
			return key
		}
	}
	return ""
}

func fileKey(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	var auth map[string]any
	if json.NewDecoder(io.LimitReader(file, 1<<20)).Decode(&auth) != nil {
		return ""
	}
	if key := usableKey(stringField(auth, "apiKey")); key != "" {
		return key
	}
	for _, id := range []string{providerID, "command-code"} {
		if credential, ok := auth[id].(map[string]any); ok {
			if key := credentialKey(credential); key != "" {
				return key
			}
		}
	}
	return ""
}

// Host-supplied credentials (including --api-key) take priority over compatibility files.
func resolveKey(input sdk.APIKeyAuthInput) (string, string, error) {
	if key := credentialKey(input.Credential); key != "" {
		return key, "credential", nil
	}
	for _, name := range []string{"COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"} {
		value := os.Getenv(name)
		if input.Ctx.Env != nil {
			resolved, err := input.Ctx.Env(name)
			if err != nil {
				return "", "", err
			}
			value = ""
			if resolved != nil {
				value = *resolved
			}
		}
		if key := usableKey(value); key != "" {
			return key, name, nil
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	for _, parts := range [][]string{{".commandcode", "auth.json"}, {".pi", "agent", "auth.json"}, {".omp", "agent", "auth.json"}} {
		if key := fileKey(filepath.Join(append([]string{home}, parts...)...)); key != "" {
			return key, "compatibility auth file", nil
		}
	}
	return "", "", nil
}

func keyAuth(base string, client *http.Client) *sdk.APIKeyAuth {
	return &sdk.APIKeyAuth{
		Name: "Command Code API key",
		Check: func(input sdk.APIKeyAuthInput) (*sdk.AuthCheck, error) {
			key, source, err := resolveKey(input)
			if err != nil || key == "" {
				return nil, err
			}
			return &sdk.AuthCheck{Type: "api_key", Source: &source}, nil
		},
		Resolve: func(input sdk.APIKeyAuthInput) (*sdk.AuthResult, error) {
			key, source, err := resolveKey(input)
			if err != nil || key == "" {
				return nil, err
			}
			return &sdk.AuthResult{Auth: map[string]any{"apiKey": key}, Source: &source}, nil
		},
		Login: func(input sdk.AuthInteraction) (map[string]any, error) {
			ctx := input.Signal
			if ctx == nil {
				ctx = context.Background()
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if input.Prompt == nil {
				return nil, errors.New("Command Code login requires a prompt callback")
			}
			value, err := input.Prompt(map[string]any{"message": "Paste your Command Code API key:"})
			if err != nil {
				return nil, err
			}
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			key := usableKey(sanitizeKey(value))
			if key == "" {
				return nil, errors.New("No Command Code API key provided")
			}
			ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(strings.TrimRight(base, "/"), "/provider/v1")+"/alpha/whoami", nil)
			if err != nil {
				return nil, errors.New("invalid Command Code API base")
			}
			req.Header.Set("Authorization", "Bearer "+key)
			res, err := client.Do(req)
			if err != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				return nil, errors.New("Could not validate the Command Code API key")
			}
			defer res.Body.Close()
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if res.StatusCode == 401 {
				return nil, errors.New("Invalid Command Code API key")
			}
			if res.StatusCode < 200 || res.StatusCode >= 300 {
				return nil, fmt.Errorf("Could not validate the Command Code API key (%d)", res.StatusCode)
			}
			return map[string]any{"type": "api_key", "key": key}, nil
		},
	}
}

func sanitizeKey(value string) string {
	for _, marker := range []string{"\x1b[200~", "\x1b[201~", "[200~", "[201~"} {
		value = strings.ReplaceAll(value, marker, "")
	}
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value))
}

func stringField(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return text
}
