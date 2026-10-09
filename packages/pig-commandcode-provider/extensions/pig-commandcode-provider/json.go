package commandcode

import (
	"encoding/json"
	"errors"
	"io"
)

// A successful prefix decode is not enough: reject trailing documents/garbage
// and enforce the byte limit even when the first JSON value is small.
func readJSONDocument(reader io.Reader, maxBytes int64, target any) error {
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > maxBytes {
		return errors.New("JSON document exceeds size limit")
	}
	return json.Unmarshal(data, target)
}
