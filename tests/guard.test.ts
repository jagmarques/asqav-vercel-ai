import { describe, it, expect, expectTypeOf, vi } from "vitest";
import { createRequire } from "node:module";
import { APIError, AuthenticationError, DetectorBlockedError, RateLimitError, type Agent } from "@asqav/sdk";
import { asqavGuard, wrapTools, AsqavBlockedError } from "../src/index.js";

// The SDK's CommonJS and ESM bundles construct different error classes.
const cjsSdk = createRequire(import.meta.url)("@asqav/sdk") as typeof import("@asqav/sdk");

/**
 * Build a mock Asqav Agent exposing only the surface the guard touches:
 * `sign` and `preflight`. Typed through `unknown` so we never depend on the
 * full Agent shape in tests.
 */
function mockAgent(overrides: Partial<{ sign: ReturnType<typeof vi.fn>; preflight: ReturnType<typeof vi.fn> }> = {}) {
  const sign = overrides.sign ?? vi.fn().mockResolvedValue({ signatureId: "sig_1" });
  const preflight =
    overrides.preflight
    ?? vi.fn().mockResolvedValue({ cleared: true, agentActive: true, policyAllowed: true, reasons: [], explanation: "ok" });
  return { agent: { sign, preflight } as unknown as Agent, sign, preflight };
}

const refusals = [
  ["revoked agent", new APIError("Agent is revoked", 400)],
  ["suspended agent", new APIError("Agent is suspended", 400)],
  ["decommissioned agent", new APIError("Agent is decommissioned", 400)],
  ["emergency halt", new APIError("Organization is under emergency halt; signing is disabled", 403)],
  ["policy deny", new APIError("policy_blocked", 403)],
  ["missing agent", new APIError("Agent not found", 404)],
  ["invalid request", new APIError("Invalid signing request", 422)],
  ["invalid credentials", new AuthenticationError()],
  ["CommonJS revoked agent", new cjsSdk.APIError("Agent is revoked", 400)],
  ["CommonJS invalid credentials", new cjsSdk.AuthenticationError()],
  ["CommonJS detector deny", new cjsSdk.DetectorBlockedError("detector_blocked", {
    allow: false, confidence: 1, labels: ["pii"], detector: "pii", reason: "Detected sensitive input",
  })],
  ["detector deny", new DetectorBlockedError("detector_blocked", {
    allow: false, confidence: 1, labels: ["pii"], detector: "pii", reason: "Detected sensitive input",
  })],
  ["detector failure with failOpen=false", new DetectorBlockedError("detector_error_blocked", {
    allow: false, confidence: 0, labels: ["error"], detector: "pii", reason: "Inspector unavailable",
  })],
] as const;

const unavailable = [
  ["network failure", new APIError("Network error: fetch failed", 0)],
  ["service outage", new APIError("Service Unavailable", 503)],
  ["request timeout", new APIError("Request Timeout", 408)],
  ["rate limit", new RateLimitError()],
  ["HTTP rate limit", new APIError("Too Many Requests", 429)],
  ["untyped error-shaped object", { name: "APIError", message: "Untrusted error shape", statusCode: 400 }],
] as const;

describe("asqavGuard", () => {
  it.each(refusals)("blocks SDK refusal %s after passing preflight", async (_name, error) => {
    const { agent, preflight, sign } = mockAgent({ sign: vi.fn().mockRejectedValue(error) });
    const execute = vi.fn();
    const onError = vi.fn();
    const guarded = asqavGuard({ execute }, { agent, toolName: "refund", onError });

    await expect(guarded.execute!({}, {})).rejects.toMatchObject({
      name: "AsqavBlockedError", toolName: "refund", reason: `signing refused: ${error.message}`,
    });
    expect(preflight).toHaveBeenCalledOnce();
    expect(sign).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error, { toolName: "refund" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(refusals)("observes SDK refusal %s when block is false", async (_name, error) => {
    for (const failClosed of [false, true]) {
      const { agent } = mockAgent({ sign: vi.fn().mockRejectedValue(error) });
      const execute = vi.fn().mockResolvedValue("observed");
      const guarded = asqavGuard({ execute }, { agent, block: false, failClosed, onError: vi.fn() });

      await expect(guarded.execute!({}, {})).resolves.toBe("observed");
      expect(execute).toHaveBeenCalledOnce();
    }
  });

  it.each(unavailable)("preserves failClosed for %s in either block mode", async (_name, error) => {
    for (const block of [false, true]) {
      for (const failClosed of [false, true]) {
        const { agent } = mockAgent({ sign: vi.fn().mockRejectedValue(error) });
        const execute = vi.fn().mockResolvedValue("ran during outage");
        const guarded = asqavGuard({ execute }, { agent, block, failClosed, onError: vi.fn() });

        if (failClosed) {
          await expect(guarded.execute!({}, {})).rejects.toMatchObject({
            name: "AsqavBlockedError", reason: "signing unavailable (fail-closed)",
          });
          expect(execute).not.toHaveBeenCalled();
        } else {
          await expect(guarded.execute!({}, {})).resolves.toBe("ran during outage");
          expect(execute).toHaveBeenCalledOnce();
        }
      }
    }
  });

  it("enforces a signing refusal even when its error callback throws", async () => {
    const { agent } = mockAgent({ sign: vi.fn().mockRejectedValue(new APIError("Agent is revoked", 400)) });
    const execute = vi.fn();
    const onError = vi.fn(() => { throw new Error("logging failed"); });
    const guarded = asqavGuard({ execute }, { agent, onError });

    await expect(guarded.execute!({}, {})).rejects.toBeInstanceOf(AsqavBlockedError);
    expect(onError).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("decides whether signing was refused before invoking its error callback", async () => {
    const error = new APIError("Agent is revoked", 400);
    const { agent } = mockAgent({ sign: vi.fn().mockRejectedValue(error) });
    const execute = vi.fn();
    const guarded = asqavGuard({ execute }, { agent, onError: () => { error.statusCode = 0; } });

    await expect(guarded.execute!({}, {})).rejects.toBeInstanceOf(AsqavBlockedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks a signing refusal after a preflight outage", async () => {
    const { agent, sign } = mockAgent({
      preflight: vi.fn().mockRejectedValue(new APIError("Network error", 0)),
      sign: vi.fn().mockRejectedValue(new APIError("Agent is revoked", 400)),
    });
    const execute = vi.fn();
    const guarded = asqavGuard({ execute }, { agent, onError: vi.fn() });

    await expect(guarded.execute!({}, {})).rejects.toBeInstanceOf(AsqavBlockedError);
    expect(sign).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("observes a preflight deny and requests a deny receipt when block is false", async () => {
    const { agent, sign } = mockAgent();
    const execute = vi.fn().mockResolvedValue("observed");
    const guarded = asqavGuard({ execute }, {
      agent, block: false, preflight: () => ({ allowed: false, reasons: ["policy refused"] }),
    });

    await expect(guarded.execute!({}, {})).resolves.toBe("observed");
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ policyDecision: "deny", reason: "policy_blocked" }));
    expect(execute).toHaveBeenCalledOnce();
  });

  it("signs the tool call before running execute", async () => {
    const { agent, sign } = mockAgent();
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const guarded = asqavGuard({ execute }, { agent, toolName: "refund" });

    const result = await guarded.execute!({ amount: 10 }, { toolCallId: "c1" });

    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toMatchObject({
      actionType: "tool:start:refund",
      toolName: "refund",
      policyDecision: "permit",
    });
    expect(sign.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
    expect(execute).toHaveBeenCalledWith({ amount: 10 }, { toolCallId: "c1" });
    expect(result).toEqual({ ok: true });
  });

  it("blocks (throws) and never runs execute when preflight refuses", async () => {
    const preflight = vi
      .fn()
      .mockResolvedValue({ cleared: false, agentActive: false, policyAllowed: false, reasons: ["agent is revoked"], explanation: "agent is revoked" });
    const { agent } = mockAgent({ preflight });
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const guarded = asqavGuard({ execute }, { agent, toolName: "wire_transfer" });

    await expect(guarded.execute!({ to: "acct" }, {})).rejects.toBeInstanceOf(AsqavBlockedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails open by default when signing throws", async () => {
    const sign = vi.fn().mockRejectedValue(new Error("network down"));
    const { agent } = mockAgent({ sign });
    const execute = vi.fn().mockResolvedValue("done");
    const onError = vi.fn();
    const guarded = asqavGuard({ execute }, { agent, toolName: "lookup", onError });

    const result = await guarded.execute!({}, {});

    expect(onError).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalled();
    expect(result).toBe("done");
  });

  it("fails open when a custom preflight throws", async () => {
    const { agent, sign } = mockAgent();
    const execute = vi.fn().mockResolvedValue("done");
    const preflight = vi.fn().mockRejectedValue(new Error("preflight unavailable"));
    const guarded = asqavGuard({ execute }, { agent, toolName: "lookup", preflight });

    const result = await guarded.execute!({ q: "status" }, { toolCallId: "c1" });

    expect(preflight).toHaveBeenCalledWith("tool:start:lookup", { q: "status" });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ q: "status" }, { toolCallId: "c1" });
    expect(result).toBe("done");
  });

  it("fails closed when failClosed is set and signing throws", async () => {
    const sign = vi.fn().mockRejectedValue(new Error("network down"));
    const { agent } = mockAgent({ sign });
    const execute = vi.fn().mockResolvedValue("done");
    const guarded = asqavGuard({ execute }, { agent, toolName: "lookup", failClosed: true });

    await expect(guarded.execute!({}, {})).rejects.toBeInstanceOf(AsqavBlockedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns a tool with no execute unchanged", () => {
    const { agent } = mockAgent();
    const tool = { description: "client side" };
    expect(asqavGuard(tool, { agent })).toBe(tool);
  });

  it.each([null, [], "tool", { execute: 1 }, { execute: null }])("rejects malformed tool %j", (tool) => {
    const { agent } = mockAgent();
    expect(() => asqavGuard(tool as never, { agent })).toThrow(TypeError);
  });

  it.each([undefined, null, {}, { agent: {} }, { agent: { sign: 1 } }])("rejects missing signing capability %j", (options) => {
    const execute = vi.fn();
    expect(() => asqavGuard({ execute }, options as never)).toThrow("options.agent must provide a sign method");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("wrapTools", () => {
  it("preserves schema types and awaits a synchronous tool result", async () => {
    const { agent } = mockAgent();
    const refund = { inputSchema: { type: "object" as const }, execute: (input: { amount: number }) => input.amount };
    const wrapped = wrapTools({ refund }, { agent });

    expectTypeOf(wrapped.refund.inputSchema).toEqualTypeOf<typeof refund.inputSchema>();
    expectTypeOf(wrapped.refund.execute).returns.toEqualTypeOf<Promise<number>>();
    expect(wrapped.refund.inputSchema).toBe(refund.inputSchema);
    await expect(wrapped.refund.execute({ amount: 50 })).resolves.toBe(50);
  });

  it("accepts an empty tool set", () => {
    const { agent } = mockAgent();
    expect(wrapTools({}, { agent })).toEqual({});
  });

  it.each([null, [], "tools"])("rejects malformed tool set %j", (tools) => {
    const { agent } = mockAgent();
    expect(() => wrapTools(tools as never, { agent })).toThrow("tools must be an object mapping names to tools");
  });

  it("wraps every tool and uses each key as the tool name", async () => {
    const { agent, sign } = mockAgent();
    const refund = vi.fn().mockResolvedValue("r");
    const lookup = vi.fn().mockResolvedValue("l");

    const wrapped = wrapTools({ refund: { execute: refund }, lookup: { execute: lookup } }, { agent });

    await wrapped.refund.execute!({}, {});
    expect(sign.mock.calls[0][0]).toMatchObject({ toolName: "refund" });
  });
});

it("types optional execute methods as returning promises", async () => {
  const { agent } = mockAgent();
  const tool: { execute?: (input: { amount: number }) => number } = {
    execute: ({ amount }) => amount,
  };
  const guarded = asqavGuard(tool, { agent });
  const wrapped = wrapTools({ optional: tool }, { agent });
  type Execute = ((input: { amount: number }) => Promise<number>) | undefined;
  expectTypeOf(guarded.execute).toEqualTypeOf<Execute>();
  expectTypeOf(wrapped.optional.execute).toEqualTypeOf<Execute>();
  await expect(guarded.execute!({ amount: 50 })).resolves.toBe(50);
  await expect(wrapped.optional.execute!({ amount: 50 })).resolves.toBe(50);
});
