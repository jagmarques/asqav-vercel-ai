/**
 * Asqav guard for the Vercel AI SDK.
 *
 * Wraps a tool's `execute` to request a receipt before the tool runs.
 * Refusals block execution by default; `failClosed` controls outages.
 *
 * The Vercel AI SDK `tool()` shape:
 *   tool({ description, inputSchema, execute })
 * where `execute` is
 *   async (input, { toolCallId, messages, abortSignal }) => result
 * The guard preserves schema fields such as `inputSchema` and `parameters`.
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

import type { Agent } from "@asqav/sdk";

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

/** Preserve schema fields and account for the guard awaiting synchronous tools. */
type GuardedExecute<T> = T extends (...args: infer Args) => infer Result
  ? (...args: Args) => Promise<Awaited<Result>> : T;

export type GuardedTool<T extends AiTool> = {
  [Key in keyof T]: Key extends "execute" ? GuardedExecute<T[Key]> : T[Key];
};

export type GuardedTools<T extends ToolSet> = { [Name in keyof T]: GuardedTool<T[Name]> };

/**
 * The preflight decision for a tool call. When `allowed` is false and
 * `block` is true, the wrapped `execute` never runs.
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
   * (pre-execution gate). When false, refusals do not block execution
   * (observe-only). Signing can fail without producing a receipt.
   */
  block?: boolean;
  /**
   * Optional preflight before signing. When supplied and it returns
   * `allowed: false`, the tool is blocked without ever signing a permit.
   * Defaults to a status + policy preflight via `agent.preflight`.
   */
  preflight?: (actionType: string, input: unknown) => Promise<GuardDecision> | GuardDecision;
  /**
   * Error sink for signing failures, including refusals. A callback exception
   * cannot replace an enforced block; otherwise it propagates.
   */
  onError?: (err: unknown, ctx: { toolName: string }) => void;
  /**
   * When true, a signing outage or other failure without an explicit refusal
   * blocks the tool (fail-closed).
   * Defaults to false. Explicit refusals follow `block` regardless of this flag.
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

/** Match the SDK's named error contract across its separate CJS/ESM classes.
 * Network failures use status 0; timeouts and rate limits are outages.
 * Other 4xx responses reject signing, including revoked agents (400). */
function isSigningRefusal(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  if (err.name === "AuthenticationError" || err.name === "DetectorBlockedError") return true;
  return err.name === "APIError" && "statusCode" in err
    && typeof err.statusCode === "number"
    && err.statusCode >= 400 && err.statusCode < 500
    && err.statusCode !== 408 && err.statusCode !== 429;
}

function validateTool(tool: AiTool): void {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    throw new TypeError("tool must be an object");
  }
  if (tool.execute !== undefined && typeof tool.execute !== "function") {
    throw new TypeError("tool.execute must be a function when supplied");
  }
}

/**
 * Run the configured preflight. Defaults to `agent.preflight`, mapping its
 * `PreflightResult` onto a `GuardDecision`. A thrown exception falls through
 * to signing; a returned refusal follows `block`, including incomplete SDK checks.
 */
async function runPreflight(
  opts: AsqavGuardOptions,
  actionType: string,
  input: unknown,
): Promise<GuardDecision> {
  try {
    if (opts.preflight) {
      return await opts.preflight(actionType, input);
    }
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
export function asqavGuard<T extends AiTool>(tool: T, options: AsqavGuardOptions): GuardedTool<T> {
  validateTool(tool);
  const original = tool.execute;
  if (typeof original !== "function") {
    return tool as GuardedTool<T>;
  }

  if (typeof options?.agent?.sign !== "function") {
    throw new TypeError("options.agent must provide a sign method");
  }

  const toolName = options.toolName ?? "tool";
  const block = options.block !== false;
  const onError = options.onError ?? defaultOnError;
  const actionType = `tool:start:${toolName}`;

  const guardedExecute = async (input: unknown, execOptions: unknown): Promise<unknown> => {
    // Optional preflight: a hard deny here blocks before any permit signs.
    const pre = await runPreflight(options, actionType, input);
    if (!pre.allowed) {
      const reason = pre.reason ?? (pre.reasons && pre.reasons.join("; ")) ?? "preflight refused";
      if (block) {
        throw new AsqavBlockedError(toolName, reason);
      }
    }

    // Request a receipt for the intended tool call before it runs.
    try {
      await options.agent.sign({
        actionType,
        toolName,
        context: { tool_name: toolName, input },
        policyDecision: pre.allowed ? "permit" : "deny",
        ...(pre.allowed ? {} : { reason: "policy_blocked" as const }),
      });
    } catch (err) {
      const refused = isSigningRefusal(err);
      try {
        onError(err, { toolName });
      } finally {
        // A diagnostic callback cannot override an enforced refusal.
        if (refused && block) {
          throw new AsqavBlockedError(toolName, `signing refused: ${err.message}`);
        }
        if (!refused && options.failClosed) {
          throw new AsqavBlockedError(toolName, "signing unavailable (fail-closed)");
        }
      }
      // Fail-open: continue to the real execute.
    }

    // Run the real tool only when allowed.
    return original(input, execOptions);
  };

  return { ...tool, execute: guardedExecute } as GuardedTool<T>;
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
export function wrapTools<T extends ToolSet>(
  tools: T,
  options: AsqavGuardOptions,
): GuardedTools<T> {
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
    throw new TypeError("tools must be an object mapping names to tools");
  }
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = asqavGuard(tool, { ...options, toolName: options.toolName ?? name });
  }
  return out as GuardedTools<T>;
}
