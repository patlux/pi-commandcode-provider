# PiG Go SDK snapshot

Source: <https://github.com/MichaelKinsy/PiG/tree/3452432f8b10edd244f7f44f73db8c97c00126cc/extensions/sdk>.

License: MIT. The original license is retained in `LICENSE`.

This directory contains the complete production Go SDK source and its JSON helper package, without upstream tests. It contains no provider HTTP clients. The native extension delegates HTTP transport to the separately pinned public PiG `ai` module.

Three SDK files differ from the source commit: `provider.go`, `provider_dispatch.go`, and `provider_proxy.go`. They expose and forward the awaited `OnProviderStreamEvent` callback using PiG's existing provider-callback protocol. The corresponding upstream patch and regression tests live in the repository's `patches/pig/` directory.

This package-owned snapshot makes the npm tarball self-contained. Its relative module replacement resolves inside the installed package, never to an external checkout. Remove the snapshot when an upstream SDK release includes these fixes, then pin that release and rerun the exact-tarball tests.
