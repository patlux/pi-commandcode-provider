// SPDX-FileCopyrightText: Copyright Hewlett Packard Enterprise Development LP
// SPDX-License-Identifier: MIT

package sdk

import (
	"embed"
	"io/fs"
	"slices"
	"strings"
)

// Source carries this package's own module sources so an installed pig can
// stage a buildable copy of the SDK to disk.
//
// A clean, binary-only host has no pig source checkout to point a `replace`
// directive at, and this module (github.com/MichaelKinsy/PiG/extensions/sdk) is a
// nested module that is not published to a public proxy. Without a local copy,
// `go build` cannot resolve the SDK, so `pig install`/`-e` and packed runtime
// cells fail to build any out-of-tree Go extension. Staging these embedded
// files (see coding/extension/pigsdk) gives every such build a local SDK
// module that always matches the running binary.
//
// bundle.go is intentionally excluded from the embed set: the staged copy is a
// minimal, dependency-free `package sdk` that does not carry the embed itself.
//
// The pattern embeds every non-test .go file, the module declaration, and its
// license rather than naming source files individually, so a new SDK source file
// is staged without a second edit here. A named list silently shipped extensions
// a partial SDK when session_mirror.go was added: the file compiled into pig, was
// never staged, and every extension kept building against an SDK missing it.
//
//go:embed LICENSE go.mod *.go json/*.go json/LICENSE
var Source embed.FS

// BundledFiles lists the embedded filenames in a stable order. It is the
// canonical set a stager must write to produce a compilable SDK module.
//
// Derived from the embed FS so it cannot drift from what is actually embedded.
// bundle.go and _test.go files are excluded: the staged module is a plain
// package sdk with no embed of its own and no tests.
func BundledFiles() []string {
	files := []string{}
	err := fs.WalkDir(Source, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && name != "bundle.go" && !strings.HasSuffix(name, "_test.go") {
			files = append(files, name)
		}
		return nil
	})
	if err != nil {
		panic("pig sdk: read embedded source: " + err.Error())
	}
	slices.Sort(files)
	return files
}
