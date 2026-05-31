/**
 * Asqav guard for the Vercel AI SDK.
 *
 * Wraps a tool's `execute` so Asqav signs the intended tool call before the
 * real `execute` runs, and can block a refused call by throwing. This is a
 * pre-execution gate: stop a rogue agent before it acts, and prove what it
 * tried.
 *
 * The Vercel AI SDK `tool()` shape (cold-verified against the current docs):
 *   tool({ description, inputSchema, execute })
 * where `execute` is
 *   async (input, { toolCallId, messages, abortSignal }) => result
 * Older AI SDK majors named the schema field `parameters`; this guard never
 * reads the schema, it only wraps `execute`, so it is schema-field agnostic
 * and works across `ai` v3/v4/v5/v6.
 *
 * Source URLs verified:
 *   - https://ai-sdk.dev/docs/foundations/tools
 *     ("inputSchema: A Zod schema or a JSON schema that defines the input";
 *      "execute: An optional async function that is called with the arguments
 *      from the tool call.")
 *   - https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
 *     (execute second arg fields: toolCallId, messages, abortSignal,
 *      experimental_context)
 */

import { Agent } from "@asqav/sdk";

/**
 * Minimal structural type for a Vercel AI SDK tool. We only need `execute`;
 * every other field (`description`, `inputSchema` / `parameters`, provider
 * extensions) is preserved untouched. Kept loose on purpose so this guard
 * stays compatible across `ai` majors without pinning a peer version.
 */
export interface AiTool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute?: (input: any, options: any) => unknown | Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export type ToolSet = Record<string, AiTool>;

/**
 * The decision an Asqav sign yields for a tool call. `allowed` is the gate:
 * when false the wrapped `execute` never runs.
 */
export interface GuardDecision {
  allowed: boolean;
  reason?: string;
  reasons?: string[];
}

export interface AsqavGuardOptions {
  /**
   * Pre-built Asqav `Agent`. Call `init()` and `Agent.create()` from
   * `@asqav/sdk` first, then pass the agent here.
   */
  agent: Agent;
  /**
   * The tool name surfaced on the signed receipt. Defaults to the key in
   * `wrapTools`, or `"tool"` for a bare `asqavGuard(tool)` call.
   */
  toolName?: string;
  /**
   * When true (default), a refused sign throws and the tool never executes
   * (pre-execution gate). When false, the call is signed for the audit trail
   * but always allowed to run (observe-only).
   */
  block?: boolean;
  /**
   * Optional preflight before signing. When supplied and it returns
   * `allowed: false`, the tool is blocked without ever signing a permit.
   * Defaults to a status + policy preflight via `agent.preflight`.
   */
  preflight?: (actionType: string, input: unknown) => Promise<GuardDecision> | GuardDecision;
  /**
   * Error sink for signing failures. Signing is fail-open by default: a
   * network error does not block the tool. Set `failClosed: true` to block
   * instead.
   */
  onError?: (err: unknown, ctx: { toolName: string }) => void;
  /**
   * When true, a signing transport error blocks the tool (fail-closed).
   * Defaults to false (fail-open): governance must not break a working agent
   * when Asqav is unreachable. A refused sign (a real deny) still blocks
   * regardless of this flag.
   */
  failClosed?: boolean;
}

/** Error thrown when Asqav refuses a tool call. The host AI SDK surfaces
 * this as a failed tool result, so the model sees the block. */
export class AsqavBlockedError extends Error {
  readonly toolName: string;
  readonly reason: string;
  constructor(toolName: string, reason: string) {
    super(`Asqav blocked tool '${toolName}': ${reason}`);
    this.name = "AsqavBlockedError";
    this.toolName = toolName;
    this.reason = reason;
  }
}

function defaultOnError(err: unknown, ctx: { toolName: string }): void {
  // eslint-disable-next-line no-console
  console.warn(`[asqav/vercel-ai] sign failed for tool '${ctx.toolName}':`, err);
}

/**
 * Run the configured preflight. Defaults to `agent.preflight`, mapping its
 * `PreflightResult` onto a `GuardDecision`. Fail-open: a preflight transport
 * error never blocks on its own (the signing step is the hard gate).
 */
async function runPreflight(
  opts: AsqavGuardOptions,
  actionType: string,
  input: unknown,
): Promise<GuardDecision> {
  if (opts.preflight) {
    return opts.preflight(actionType, input);
  }
  try {
    const result = await opts.agent.preflight(actionType);
    return {
      allowed: result.cleared,
      reason: result.cleared ? undefined : result.explanation,
      reasons: result.reasons,
    };
  } catch {
    // Preflight is best-effort; the sign call is the authoritative gate.
    return { allowed: true };
  }
}

/**
 * Wrap a single Vercel AI SDK tool so Asqav signs the call before `execute`
 * runs. A tool with no `execute` (a client-side or provider-executed tool) is
 * returned unchanged.
 */
export function asqavGuard(tool: AiTool, options: AsqavGuardOptions): AiTool {
  const original = tool.execute;
  if (typeof original !== "function") {
    return tool;
  }

  const toolName = options.toolName ?? "tool";
  const block = options.block !== false;
  const onError = options.onError ?? defaultOnError;
  const actionType = `tool:start:${toolName}`;

  const guardedExecute = async (input: unknown, execOptions: unknown): Promise<unknown> => {
    // 1. Optional preflight: a hard deny here blocks before any permit signs.
    const pre = await runPreflight(options, actionType, input);
    if (!pre.allowed) {
      const reason = pre.reason ?? (pre.reasons && pre.reasons.join("; ")) ?? "preflight refused";
      if (block) {
        throw new AsqavBlockedError(toolName, reason);
      }
    }

    // 2. Sign the intended tool call. The receipt records what the agent
    //    tried, before it runs.
    try {
      await options.agent.sign({
        actionType,
        toolName,
        context: { tool_name: toolName, input },
        policyDecision: pre.allowed ? "permit" : "deny",
        ...(pre.allowed ? {} : { reason: "policy_blocked" as const }),
      });
    } catch (err) {
      onError(err, { toolName });
      if (options.failClosed) {
        throw new AsqavBlockedError(toolName, "signing unavailable (fail-closed)");
      }
      // Fail-open: continue to the real execute.
    }

    // 3. Run the real tool only when allowed.
    return original(input, execOptions);
  };

  return { ...tool, execute: guardedExecute };
}

/**
 * Wrap every tool in a Vercel AI SDK tool set. Pass the same object you would
 * hand to `generateText({ tools })` / `streamText({ tools })`. Each tool's
 * key becomes its `toolName` on the signed receipt.
 *
 * Usage:
 *   import { generateText } from "ai";
 *   import { init, Agent } from "@asqav/sdk";
 *   import { wrapTools } from "@asqav/vercel-ai";
 *
 *   init({ apiKey: process.env.ASQAV_API_KEY! });
 *   const agent = await Agent.create({ name: "support-bot" });
 *
 *   await generateText({
 *     model,
 *     prompt: "Refund order 1234",
 *     tools: wrapTools({ refund, lookupOrder }, { agent }),
 *   });
 */
export function wrapTools(
  tools: ToolSet,
  options: AsqavGuardOptions,
): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = asqavGuard(tool, { ...options, toolName: options.toolName ?? name });
  }
  return out;
}
