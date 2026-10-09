package sdk

import (
	"bytes"
	"encoding/json"
	"maps"
	"math"
	"strconv"
)

// oauthExpiry retains an expires value that the int64 projection cannot represent: an absent property, a fraction, an out-of-range number, or a non-number value. It applies only while Expires still equals projection.
type oauthExpiry struct {
	value      json.RawMessage // exact JSON; nil means absent
	number     float64         // the JSON number, or NaN when absent or not a number
	projection int64
	isNumber   bool
	set        bool
}

func (e oauthExpiry) current(expires int64) bool { return e.set && e.projection == expires }

// exactExpiresInt64 accepts only safe integers: JSON.stringify writes a larger integer with Number::toString digits (2**60 is 1152921504606847000), which the int64 encoding of the projection would not reproduce.
func exactExpiresInt64(value float64) (int64, bool) {
	if value != math.Trunc(value) || value < -(1<<53) || value > 1<<53 {
		return 0, false
	}
	return int64(value), true
}

func expiresProjection(value float64) int64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < -(1<<63) || value >= 1<<63 {
		return 0
	}
	return int64(math.Trunc(value))
}

// expiresNumberJSON returns JSON.stringify of a JavaScript number: non-finite values are null and -0 is 0.
func expiresNumberJSON(value float64) json.RawMessage {
	switch {
	case math.IsNaN(value) || math.IsInf(value, 0):
		return json.RawMessage("null")
	case value == 0:
		return json.RawMessage("0")
	}
	encoded, _ := json.Marshal(value)
	return encoded
}

func decodeOAuthExpiry(raw json.RawMessage, present bool) (int64, oauthExpiry) {
	if !present {
		return 0, oauthExpiry{number: math.NaN(), set: true}
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && (raw[0] == '-' || raw[0] >= '0' && raw[0] <= '9') {
		number, err := strconv.ParseFloat(string(raw), 64)
		if err != nil && !math.IsInf(number, 0) {
			number = math.NaN()
		}
		if integer, ok := exactExpiresInt64(number); ok {
			return integer, oauthExpiry{}
		}
		// JSON.parse then JSON.stringify: an overflowing literal becomes null.
		projection := expiresProjection(number)
		return projection, oauthExpiry{value: expiresNumberJSON(number), number: number, projection: projection, isNumber: true, set: true}
	}
	return 0, oauthExpiry{value: bytes.Clone(raw), number: math.NaN(), set: true}
}

// ExpiresMillis returns the exact expires number and true when the property is a JSON number. It returns NaN and false when the property is absent or holds a value that Pi's declared number type excludes; such a value still round-trips unchanged.
func (c OAuthCredentials) ExpiresMillis() (float64, bool) {
	if c.expiry.current(c.Expires) {
		return c.expiry.number, c.expiry.isNumber
	}
	return float64(c.Expires), true
}

// HasExpires reports whether the credential carries an expires property.
func (c OAuthCredentials) HasExpires() bool {
	return !c.expiry.current(c.Expires) || c.expiry.value != nil
}

// SetExpiresMillis stores a JavaScript number, including a fraction. Expires receives its truncated projection.
func (c *OAuthCredentials) SetExpiresMillis(value float64) {
	if integer, ok := exactExpiresInt64(value); ok {
		c.Expires, c.expiry = integer, oauthExpiry{}
		return
	}
	projection := expiresProjection(value)
	c.Expires, c.expiry = projection, oauthExpiry{value: expiresNumberJSON(value), number: value, projection: projection, isNumber: true, set: true}
}

// ClearExpires removes the expires property.
func (c *OAuthCredentials) ClearExpires() {
	c.Expires, c.expiry = 0, oauthExpiry{number: math.NaN(), set: true}
}

// oauthOptionalStrings are the named optional fields. A value that is not a nonempty string stays in Extra.
var oauthOptionalStrings = []string{"projectId", "accountId", "scope"}

func (c OAuthCredentials) MarshalJSON() ([]byte, error) {
	fields := maps.Clone(c.Extra)
	if fields == nil {
		fields = map[string]json.RawMessage{}
	}
	put := func(key string, value any) error {
		encoded, err := json.Marshal(value)
		fields[key] = encoded
		return err
	}
	if err := put("refresh", c.Refresh); err != nil {
		return nil, err
	}
	if err := put("access", c.Access); err != nil {
		return nil, err
	}
	delete(fields, "expires")
	if c.expiry.current(c.Expires) {
		if c.expiry.value != nil {
			fields["expires"] = c.expiry.value
		}
	} else if err := put("expires", c.Expires); err != nil {
		return nil, err
	}
	for key, value := range map[string]string{"projectId": c.ProjectID, "accountId": c.AccountID, "scope": c.Scope} {
		if value != "" {
			if err := put(key, value); err != nil {
				return nil, err
			}
		}
	}
	return json.Marshal(fields)
}

func (c *OAuthCredentials) UnmarshalJSON(data []byte) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		return err
	}
	var decoded OAuthCredentials
	for _, key := range []string{"refresh", "access"} {
		raw, ok := object[key]
		if !ok {
			continue
		}
		target := &decoded.Refresh
		if key == "access" {
			target = &decoded.Access
		}
		if err := json.Unmarshal(raw, target); err != nil {
			return err
		}
		delete(object, key)
	}
	raw, present := object["expires"]
	delete(object, "expires")
	decoded.Expires, decoded.expiry = decodeOAuthExpiry(raw, present)
	for _, key := range oauthOptionalStrings {
		var value string
		if json.Unmarshal(object[key], &value) != nil || value == "" {
			continue
		}
		switch key {
		case "projectId":
			decoded.ProjectID = value
		case "accountId":
			decoded.AccountID = value
		case "scope":
			decoded.Scope = value
		}
		delete(object, key)
	}
	if len(object) > 0 {
		decoded.Extra = object
	}
	*c = decoded
	return nil
}
