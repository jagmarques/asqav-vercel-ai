# Security Policy

## Reporting Vulnerabilities

Email info@asqav.com with details. We will respond within 48 hours.

Do not open public issues for security vulnerabilities.

## Supported Versions

Only the latest published release is supported.

## Scope

This repository contains @asqav/vercel-ai, the Vercel AI SDK tool guard for Asqav.

Report issues that affect:
- Tool-call interception and the pre-execution gate
- Bypasses that let a denied tool call still execute
- Payload tampering before submission to the Asqav API

Cryptographic signing runs server-side via the Asqav API. Report signing or key-handling issues against [asqav-sdk](https://github.com/jagmarques/asqav-sdk).
