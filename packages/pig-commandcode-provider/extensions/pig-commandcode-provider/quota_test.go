package commandcode

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestQuotaPreservesPartialSectionsAndFailsClosedOnAuth(t *testing.T) {
	for _, status := range []int{503, 401} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer synthetic" {
					t.Error("missing auth")
				}
				switch r.URL.Path {
				case "/alpha/whoami":
					fmt.Fprint(w, `{"org":{"id":"org","login":"test"}}`)
				case "/alpha/billing/credits":
					w.WriteHeader(status)
					fmt.Fprint(w, "Bearer synthetic")
				case "/alpha/billing/subscriptions":
					fmt.Fprint(w, `{"data":{"planId":"go","status":"active","currentPeriodStart":"2026-10-01"}}`)
				case "/alpha/usage/summary":
					if r.URL.Query().Get("since") != "2026-10-01" || r.URL.Query().Get("orgId") != "org" {
						t.Error("lost query")
					}
					fmt.Fprint(w, `{"totalCost":2,"totalCount":4}`)
				default:
					t.Errorf("unexpected path %s", r.URL.Path)
				}
			}))
			defer server.Close()
			text, err := fetchQuota(context.Background(), server.Client(), server.URL, "synthetic", nil)
			if status == 401 {
				if err == nil {
					t.Fatal("auth rejection masked by partial data")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(text, "Credits: unavailable") || !strings.Contains(text, "Subscription: go active") || !strings.Contains(text, "Usage: $2.0000 / 4 requests") || strings.Contains(text, "synthetic") {
				t.Fatalf("wrong quota output: %s", text)
			}
		})
	}
}
