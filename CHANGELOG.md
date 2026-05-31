# Changelog

All notable changes to `@asqav/vercel-ai` are listed here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer](https://semver.org/) and track the `package.json` version.

## [Unreleased]

## [0.1.0] - 2026-05-31

Initial release. `asqavGuard` and `wrapTools` wrap a Vercel AI SDK tool's `execute` so Asqav signs the intended tool call before it runs and blocks a refused call by throwing. Schema-field agnostic across `ai` v3 through v6. Fail-open by default with an opt-in fail-closed mode.
