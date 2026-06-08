<p align="center">
  <a href="https://asqav.com"><img src="https://asqav.com/logo-text-white.png" alt="Asqav" width="150"></a>
</p>

# @asqav/vercel-ai

Stop a rogue agent before it acts, and prove what it tried. This package guards [Vercel AI SDK](https://ai-sdk.dev) tool calls with Asqav. It signs the intended tool call before the tool's `execute` runs, and blocks the call when Asqav refuses. Every attempt becomes a tamper-evident receipt, signed server-side with NIST FIPS 204 ML-DSA-65. The agent never holds the signing key, so it cannot forge the record.

This is a pre-execution gate. The guard runs at tool-execution time, signs `tool:start`, and throws when a call is refused so the tool never executes.

## How it hooks in

The Vercel AI SDK defines a tool as `tool({ description, inputSchema, execute })`, where `execute` is `async (input, { toolCallId, messages, abortSignal }) => result`. The guard wraps `execute` only. It never touches your schema, so it works whether your `ai` version names the schema field `inputSchema` on v5 and v6 or `parameters` on v4. A tool with no `execute`, meaning a client-side or provider-executed tool, is returned unchanged.

References, cold-verified:
- [Tools foundation](https://ai-sdk.dev/docs/foundations/tools), covering `inputSchema` and `execute`
- [Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), covering the `execute` second argument `toolCallId`, `messages`, and `abortSignal`

## Install

Not yet published to npm. Install from GitHub or a local path:

```bash
npm install github:jagmarques/asqav-vercel-ai
```

Or clone and add as a local path dependency:

```bash
git clone https://github.com/jagmarques/asqav-vercel-ai.git
```

```json
{
  "dependencies": {
    "@asqav/vercel-ai": "file:../asqav-vercel-ai",
    "@asqav/sdk": "^0.5.5"
  }
}
```

## Quick start

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
  // Every tool call is signed before it runs. A refused call throws and
  // the tool never executes.
  tools: wrapTools({ refund }, { agent }),
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
- `block`, defaulting to `true`: when a sign is refused, throw so the tool never runs. Set `false` for observe-only signing.
- `preflight`: a custom `(actionType, input) => { allowed, reason }` check. Defaults to `agent.preflight`, which checks revocation, suspension, and active policies.
- `failClosed`, defaulting to `false`: when a signing transport error occurs, block the tool. The default is fail-open so an unreachable Asqav never breaks a working agent. A real deny still blocks regardless.
- `onError`: sink for signing transport errors. Defaults to `console.warn`.

## How blocking works

When the guard blocks, it throws `AsqavBlockedError`. The Vercel AI SDK surfaces a thrown `execute` as a failed tool result, so the model sees the block and can react. The receipt for the refused call records `policy_decision: "deny"`, giving you proof of what the agent tried.

## License

MIT
