import { describe, it, expect, vi } from "vitest";
import type { Agent } from "@asqav/sdk";
import { asqavGuard, wrapTools, AsqavBlockedError } from "../src/index.js";

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

describe("asqavGuard", () => {
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
    // Sign happened before execute returned the real result.
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
});

describe("wrapTools", () => {
  it("wraps every tool and uses each key as the tool name", async () => {
    const { agent, sign } = mockAgent();
    const refund = vi.fn().mockResolvedValue("r");
    const lookup = vi.fn().mockResolvedValue("l");

    const wrapped = wrapTools({ refund: { execute: refund }, lookup: { execute: lookup } }, { agent });

    await wrapped.refund.execute!({}, {});
    expect(sign.mock.calls[0][0]).toMatchObject({ toolName: "refund" });
  });
});
