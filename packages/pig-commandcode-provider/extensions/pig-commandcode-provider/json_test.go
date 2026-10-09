package commandcode

import (
	"errors"
	"io"
	"strings"
	"testing"
)

type failedJSONReader struct{}

func (failedJSONReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestJSONDocumentEnforcesFullBodyAndByteLimit(t *testing.T) {
	for _, test := range []struct {
		name, body string
		limit      int64
		valid      bool
	}{
		{"exact limit", `{"ok":true}`, 11, true},
		{"under limit", `{"ok":true}`, 12, true},
		{"over limit", `{"ok":true}`, 10, false},
		{"valid whitespace", "{} \n\t", 5, true},
		{"oversized whitespace", "{} \n\t", 4, false},
		{"multiple documents", "{}{}", 4, false},
		{"garbage suffix", "{}oops", 6, false},
		{"truncated", `{"ok":`, 10, false},
		{"byte not rune limit", `{"x":"é"}`, 9, false},
		{"unicode exact limit", `{"x":"é"}`, 10, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var target map[string]any
			err := readJSONDocument(strings.NewReader(test.body), test.limit, &target)
			if (err == nil) != test.valid {
				t.Fatalf("valid=%v err=%v", test.valid, err)
			}
		})
	}
	var target map[string]any
	if err := readJSONDocument(failedJSONReader{}, 100, &target); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("read error was lost: %v", err)
	}
}
