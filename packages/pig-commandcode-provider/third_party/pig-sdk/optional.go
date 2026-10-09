package sdk

// Bool returns a pointer to v for an optional boolean field. Nil leaves the option unset; Bool(false) explicitly disables it.
// pig additive (D19): Go construction helper for the shared optional-boolean contract.
func Bool(v bool) *bool { return new(v) }

// TokensOr returns the token count, or fallback when it is unknown. It does not change the nullable Tokens field.
// pig additive (D19): the caller explicitly selects the fallback for a nullable count.
func (u ContextUsage) TokensOr(fallback int) int {
	if u.Tokens == nil {
		return fallback
	}
	return *u.Tokens
}

// PercentOr returns the usage percentage, or fallback when it is unknown. It does not change the nullable Percent field.
// pig additive (D19): the caller explicitly selects the fallback for a nullable percentage.
func (u ContextUsage) PercentOr(fallback float64) float64 {
	if u.Percent == nil {
		return fallback
	}
	return *u.Percent
}
