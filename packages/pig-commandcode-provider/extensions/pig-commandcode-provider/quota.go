package commandcode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type quotaSection struct {
	data   map[string]any
	status int
	err    error
}

func fetchQuota(ctx context.Context, client *http.Client, base, key string, headers map[string]string) (string, error) {
	if key == "" {
		return "", errors.New("No Command Code API key found")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	base = strings.TrimSuffix(strings.TrimRight(base, "/"), "/provider/v1")
	request := func(path string) quotaSection {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
		if err != nil {
			return quotaSection{err: err}
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Bearer "+key)
		for name, value := range headers {
			req.Header.Set(name, value)
		}
		res, err := client.Do(req)
		if err != nil {
			return quotaSection{err: errors.New("quota request failed or timed out")}
		}
		defer res.Body.Close()
		section := quotaSection{status: res.StatusCode}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			section.err = fmt.Errorf("quota HTTP %d", res.StatusCode)
			return section
		}
		if json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&section.data) != nil {
			section.err = errors.New("invalid quota response")
		}
		return section
	}
	who := request("/alpha/whoami")
	if who.err != nil {
		return "", who.err
	}
	org, _ := who.data["org"].(map[string]any)
	user, _ := who.data["user"].(map[string]any)
	login := stringField(org, "login")
	if login == "" {
		login = stringField(user, "userName")
	}
	if login == "" {
		login = stringField(user, "name")
	}
	if login == "" {
		return "", errors.New("unrecognized Command Code account response")
	}
	query := url.Values{}
	if id := stringField(org, "id"); id != "" {
		query.Set("orgId", id)
	}
	withQuery := func(path string) string {
		if len(query) == 0 {
			return path
		}
		return path + "?" + query.Encode()
	}
	var credits, subscription quotaSection
	var group sync.WaitGroup
	group.Go(func() { credits = request(withQuery("/alpha/billing/credits")) })
	group.Go(func() { subscription = request(withQuery("/alpha/billing/subscriptions")) })
	group.Wait()
	for _, section := range []quotaSection{credits, subscription} {
		if section.status == 401 || section.status == 403 {
			return "", errors.New("Command Code rejected the API key during quota lookup")
		}
	}
	sub, _ := subscription.data["data"].(map[string]any)
	if since := sub["currentPeriodStart"]; since != nil {
		switch since := since.(type) {
		case string:
			query.Set("since", since)
		case float64:
			query.Set("since", fmt.Sprintf("%.0f", since))
		}
	}
	summary := request(withQuery("/alpha/usage/summary"))
	if summary.status == 401 || summary.status == 403 {
		return "", errors.New("Command Code rejected the API key during usage lookup")
	}
	lines := []string{"Command Code — " + safeError(login, key)}
	available := 0
	credit, _ := credits.data["credits"].(map[string]any)
	if credits.err == nil && credit != nil {
		total := 0.0
		recognized := false
		for _, name := range []string{"monthlyCredits", "purchasedCredits", "freeCredits"} {
			if number, ok := credit[name].(float64); ok && number >= 0 {
				total += number
				recognized = true
			}
		}
		if recognized {
			lines = append(lines, fmt.Sprintf("Credits remaining: %.2f", total))
			available++
		} else {
			lines = append(lines, "Credits: unavailable")
		}
		windows, _ := credits.data["windowLimits"].(map[string]any)
		for _, name := range []string{"fiveHour", "weekly"} {
			if window, ok := windows[name].(map[string]any); ok {
				used, usedOK := window["used"].(float64)
				cap, capOK := window["cap"].(float64)
				if usedOK && capOK && used >= 0 && cap >= 0 && (used > 0 || cap > 0) {
					lines = append(lines, fmt.Sprintf("%s: %.2f / %.2f", name, used, cap))
				}
			}
		}
	} else {
		lines = append(lines, "Credits: unavailable")
	}
	if subscription.err == nil && sub != nil && (stringField(sub, "planId") != "" || stringField(sub, "status") != "" || sub["currentPeriodStart"] != nil || sub["currentPeriodEnd"] != nil) {
		lines = append(lines, "Subscription: "+safeError(strings.TrimSpace(stringField(sub, "planId")+" "+stringField(sub, "status")), key))
		available++
	} else {
		lines = append(lines, "Subscription: unavailable")
	}
	cost, costOK := summary.data["totalCost"].(float64)
	count, countOK := summary.data["totalCount"].(float64)
	if summary.err == nil && costOK && countOK && cost >= 0 && count >= 0 {
		lines = append(lines, fmt.Sprintf("Usage: $%.4f / %.0f requests", cost, count))
		available++
	} else {
		lines = append(lines, "Usage: unavailable")
	}
	if available == 0 {
		return "", errors.New("Command Code returned no recognized quota data")
	}
	return strings.Join(lines, "\n"), nil
}
