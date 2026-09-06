<p align="center">
  <a href="https://asqav.com"><img src="https://asqav.com/logo-text-white.png" alt="Asqav" width="150"></a>
</p>

# @asqav/vercel-ai

This package guards [Vercel AI SDK](https://ai-sdk.dev) tool calls with Asqav. It requests a signed receipt before the tool's `execute` runs and blocks signing refusals by default. Successful signing produces a receipt signed server-side with ML-DSA-65; a refused request or an outage can leave no receipt. The agent never holds the signing key.

Asqav governs the agents you wire through it. An agent that never routes through the governed path produces no receipt and is not detected.

The guard runs at tool-execution time and signs `tool:start:<toolName>`. With `block: true`, a preflight or signing refusal throws before the tool executes. Set `failClosed: true` to also block during a signing outage.

## How it hooks in

The Vercel AI SDK defines a tool as `tool({ description, inputSchema, execute })`, where `execute` is `async (input, { toolCallId, messages, abortSignal }) => result`. The guard wraps `execute` and preserves the tool's schema fields and types, including `inputSchema` or `parameters`. A tool with no `execute`, meaning a client-side or provider-executed tool, is returned unchanged.

This wrapper supports tools that return a value or a Promise. Async-generator and other `AsyncIterable` tool results are not supported; their streamed values will not be consumed through this wrapper.

References:
- [Tools foundation](https://ai-sdk.dev/docs/foundations/tools), covering `inputSchema` and `execute`
- [Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), covering the `execute` second argument `toolCallId`, `messages`, and `abortSignal`

## Install

Use Node.js 20.19.0 or newer on the 20.x line, or Node.js 22.12.0 or newer. The package supports ESM `import` and CommonJS `require`.

The npm release `0.1.0` can execute a tool after signing is refused. Install from GitHub or a local path to use the refusal handling described here:

```bash
npm install github:jagmarques/asqav-vercel-ai '@asqav/sdk@^0.10.10'
```

Or clone and add as a local path dependency:

```bash
git clone https://github.com/jagmarques/asqav-vercel-ai.git
```

```json
{
  "dependencies": {
    "@asqav/vercel-ai": "file:../asqav-vercel-ai",
    "@asqav/sdk": "^0.10.10"
  }
}
```

## Quick start

This example uses AI SDK 7 and its OpenAI provider, which require Node.js 22 or newer; use Node.js 22.12.0 or newer with this package. Configure `ASQAV_API_KEY` and `OPENAI_API_KEY` before running it.

```bash
npm install 'ai@^7' '@ai-sdk/openai@^4' 'zod@^4'
```

```ts
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { tool } from "ai";
import { init, Agent } from "@asqav/sdk";
import { wrapTools } from "@asqav/vercel-ai";

init({ apiKey: process.env.ASQAV_API_KEY! });
const agent = await Agent.create({ name: "support-bot" });

const refund = tool({
  description: "Refund a customer order",
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  execute: async ({ orderId, amount }) => {
    // your real refund call
    return { refunded: amount, orderId };
  },
});

const result = await generateText({
  model: openai("gpt-4o"),
  prompt: "Refund order 1234 for 50 dollars",
  // Require successful signing before the refund runs.
  tools: wrapTools({ refund }, { agent, failClosed: true }),
});
```

## Guard one tool

```ts
import { asqavGuard } from "@asqav/vercel-ai";

const guarded = asqavGuard(refund, { agent, toolName: "refund" });
```

## Options

`wrapTools(tools, options)` and `asqavGuard(tool, options)` accept:

- `agent`, required: a pre-built Asqav `Agent` from `@asqav/sdk`.
- `toolName`: the name on the signed receipt. `wrapTools` defaults to each tool's key.
- `block`, defaulting to `true`: block preflight and signing refusals. Set `false` to observe refusals and let the tool run; signing may produce no receipt. `failClosed` still controls outages in this mode.
- `preflight`: a custom `(actionType, input) => { allowed, reason }` check. Defaults to `agent.preflight`, which checks revocation, suspension, and active policies. The SDK can return a refusal when those checks cannot complete; this follows `block`, regardless of `failClosed`. A thrown preflight exception falls through to signing.
- `failClosed`, defaulting to `false`: block when signing fails because of a network error, timeout, rate limit, server error, or another failure without an explicit refusal. With the default, the tool can run without a receipt. Signing refusals follow `block` regardless of `failClosed`.
- `onError`: sink for signing errors, including refusals. Defaults to `console.warn`. A callback that throws cannot replace an enforced `AsqavBlockedError`; when the guard allows execution, a callback exception still propagates.

## How blocking works

When the guard blocks, it throws `AsqavBlockedError`. The Vercel AI SDK surfaces a thrown `execute` as a failed tool result, so the model can see the block. The guard honors SDK authentication errors, detector blocks, and HTTP 4xx signing errors except timeouts (408) and rate limits (429). This includes revoked or suspended agents, which the signing API rejects with HTTP 400.

A preflight refusal blocks before signing, so this guard creates no receipt for that attempt. A signing refusal also does not guarantee a receipt. With `block: false`, a preflight deny requests a receipt with `policy_decision: "deny"` and `reason: "policy_blocked"`; that request can still fail.

## License

[Elastic License 2.0](LICENSE)
