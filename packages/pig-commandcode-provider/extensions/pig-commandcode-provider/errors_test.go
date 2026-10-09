package commandcode

import (
	"strings"
	"testing"
)

func TestOverflowNormalizationDoesNotMisclassifyQuota(t *testing.T) {
	for _, text := range []string{"context window exceeded", "prompt too long", "input_tokens_limit_exceeded", "maximum allowed context length", "context overflow"} {
		if !strings.HasPrefix(safeError(text, ""), "context_length_exceeded:") {
			t.Errorf("not normalized: %s", text)
		}
	}
	for _, text := range []string{"rate limit: too many tokens this minute", "context window metadata unavailable", "HTTP 429: maximum allowed input tokens reached", "quota exhausted for context window", "context_length_exceeded: already normalized"} {
		if got := safeError(text, ""); got != text {
			t.Errorf("incorrect normalization: %q -> %q", text, got)
		}
	}
}

func TestErrorRedactionCoversEchoedCredentials(t *testing.T) {
	for _, secret := range []string{"sk-abcdefghijklmnopqrstuv", "user_abcdefghijklmnop", "cc_abcdefghijklmnop"} {
		if strings.Contains(safeError("provider error "+secret, "current-key"), secret) {
			t.Errorf("unredacted credential %q", secret)
		}
	}
	for _, text := range []string{"api_key=other-credential", `{"access_token":"other-credential"}`, "https://example.invalid/?token=other-credential", "password:other-credential"} {
		if strings.Contains(safeError(text, "current-key"), "other-credential") {
			t.Errorf("unredacted credential in %s", text)
		}
	}
}
