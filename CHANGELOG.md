# Changelog

Notable changes to @asqav/vercel-ai. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

First release.

### Added
- `asqavGuard` and `wrapTools`: wrap a Vercel AI SDK tool's `execute` so Asqav
  signs the intended tool call before it runs and blocks a refused call by
  throwing `AsqavBlockedError` (a pre-execution gate). An observe-only mode
  signs the call for the audit trail without blocking.
- Tag-gated npm publish workflow with provenance through GitHub OIDC.
- Pull-request CI that installs, builds, and runs `npm publish --dry-run`.

### Changed
- Pinned the `@asqav/sdk` dependency to `^0.8.0`.
