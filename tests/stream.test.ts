import { describe, it, expect, expectTypeOf, vi } from "vitest";
import { executeTool } from "@ai-sdk/provider-utils";
import { tool, type Tool, type InferToolOutput } from "ai";
import { z } from "zod";
import { APIError, type Agent } from "@asqav/sdk";
import { asqavGuard, asqavStreamGuard, wrapTools, type AiTool } from "../src/index.js";

const inputSchema = z.object({ n: z.number() });
const contextSchema = z.object({ tenant: z.string() });
const execOptions = { context: { tenant: "local" }, toolCallId: "stream-1", messages: [], abortSignal: new AbortController().signal };
async function collect<T>(stream: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of stream) result.push(item);
  return result;
}
function agent(sign = vi.fn().mockResolvedValue({ signatureId: "fixture" })) {
  return { sign, preflight: vi.fn().mockResolvedValue({ cleared: true }) } as unknown as Agent;
}

describe("streamed execution with the actual AI SDK dispatcher", () => {
  it("preserves preliminary and final outputs, signing once before any tool work", async () => {
    const order: string[] = [];
    const sign = vi.fn(async () => { order.push("sign"); });
    const source = tool({ inputSchema, contextSchema, async *execute({ n }, options) {
      order.push("body");
      expect(options).toBe(execOptions);
      yield n; yield n + 1;
    } });
    const guarded = asqavStreamGuard(source, { agent: agent(sign) });
    expect(guarded.inputSchema).toBe(inputSchema);
    expect(source.execute).not.toBe(guarded.execute);
    const output = await collect(executeTool({ tool: guarded, input: { n: 1 }, options: execOptions }));
    expect(output).toEqual([
      { type: "preliminary", output: 1 }, { type: "preliminary", output: 2 }, { type: "final", output: 2 },
    ]);
    expect(order).toEqual(["sign", "body"]);
    expect(sign).toHaveBeenCalledOnce();
    expectTypeOf(output[0].output).toEqualTypeOf<number>();
  });

  it.each(["plain", "promised"])("consumes %s custom AsyncIterables without eager execution", async kind => {
    const factory = vi.fn(() => ({ async *[Symbol.asyncIterator]() { yield 7; } }));
    const source = { inputSchema, contextSchema, execute: () => kind === "plain" ? factory() : Promise.resolve(factory()) };
    const guarded = asqavStreamGuard(source, { agent: agent() });
    const stream = guarded.execute();
    expect(factory).not.toHaveBeenCalled();
    expect(await collect(stream)).toEqual([7]);
    expect(factory).toHaveBeenCalledOnce();
  });

  it.each(["preflight", "refusal", "outage", "callback"])("blocks %s before creating or iterating a stream", async kind => {
    const factory = vi.fn(() => ({ async *[Symbol.asyncIterator]() { throw new Error("tool ran"); } }));
    const sign = vi.fn().mockRejectedValue(new APIError("blocked", kind === "outage" ? 503 : 403));
    const guarded = asqavStreamGuard({ inputSchema, contextSchema, execute: factory }, {
      agent: agent(sign), failClosed: true,
      preflight: () => ({ allowed: kind !== "preflight" }),
      onError: () => { if (kind === "callback") throw new Error("sink failed"); },
    });
    await expect(collect(executeTool({ tool: guarded, input: { n: 1 }, options: execOptions })))
      .rejects.toMatchObject({ name: "AsqavBlockedError" });
    expect(factory).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledTimes(kind === "preflight" ? 0 : 1);
  });

  it("waits for signing to resolve before calling the stream factory", async () => {
    let release!: () => void;
    const sign = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const factory = vi.fn(async function* () { yield 4; });
    const stream = asqavStreamGuard({ execute: factory }, { agent: agent(sign) }).execute();
    const next = stream.next();
    await vi.waitFor(() => expect(sign).toHaveBeenCalledOnce());
    expect(factory).not.toHaveBeenCalled();
    release();
    expect(await next).toEqual({ value: 4, done: false });
    expect(factory).toHaveBeenCalledOnce();
    await stream.return();
  });

  it("closes the underlying iterator when a consumer stops between outputs", async () => {
    const closed = vi.fn();
    let iterations = 0;
    const source = { inputSchema, contextSchema, async *execute() {
      try { iterations++; yield 1; iterations++; yield 2; } finally { closed(); }
    } };
    const results = executeTool({ tool: asqavStreamGuard(source, { agent: agent() }), input: { n: 0 }, options: execOptions });
    expect(await results.next()).toEqual({ done: false, value: { type: "preliminary", output: 1 } });
    await results.return(undefined);
    expect(closed).toHaveBeenCalledOnce();
    expect(iterations).toBe(1);
  });

  it("does not sign or invoke a stream closed before its first iteration", async () => {
    const sign = vi.fn();
    const execute = vi.fn(async function* () { yield 1; });
    const stream = asqavStreamGuard({ execute }, { agent: agent(sign) }).execute();
    await stream.return();
    expect(sign).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it("preserves a stream error after a preliminary output", async () => {
    const failure = new Error("tool failed");
    const source = { inputSchema, contextSchema, async *execute() { yield 1; throw failure; } };
    const results = executeTool({ tool: asqavStreamGuard(source, { agent: agent() }), input: { n: 0 }, options: execOptions });
    expect((await results.next()).value).toEqual({ type: "preliminary", output: 1 });
    await expect(results.next()).rejects.toBe(failure);
  });

  it("preserves the dispatcher's empty-stream result", async () => {
    const source = { inputSchema, contextSchema, async *execute() { return; yield 1; } };
    expect(await collect(executeTool({ tool: asqavStreamGuard(source, { agent: agent() }), input: { n: 0 }, options: execOptions })))
      .toEqual([{ type: "final", output: undefined }]);
  });

  it.each([403, 503])("preserves explicitly allowed signing failures (%i)", async status => {
    const source = { inputSchema, contextSchema, async *execute() { yield "ran"; } };
    const guarded = asqavStreamGuard(source, {
      agent: agent(vi.fn().mockRejectedValue(new APIError("failed", status))),
      block: false, onError: () => {},
    });
    expect(await collect(guarded.execute())).toEqual(["ran"]);
  });

  it("keeps ordinary and Promise tools at exactly one final output", async () => {
    for (const execute of [() => 3, async () => 3]) {
      const wrapped = wrapTools({ sum: { inputSchema, contextSchema, execute } }, { agent: agent() });
      expect(await collect(executeTool({ tool: wrapped.sum, input: { n: 0 }, options: execOptions })))
        .toEqual([{ type: "final", output: 3 }]);
    }
  });

  it("rejects a stream through the scalar guard instead of returning its iterator as output", async () => {
    const source = { inputSchema, contextSchema, async *execute() { yield 1; } };
    await expect(collect(executeTool({ tool: asqavGuard(source, { agent: agent() }), input: { n: 0 }, options: execOptions })))
      .rejects.toThrow("AsyncIterable tool results require asqavStreamGuard");
    await expect(collect(asqavStreamGuard({ execute: () => 1 }, { agent: agent() }).execute()))
      .rejects.toThrow("asqavStreamGuard requires an AsyncIterable tool result");
  });

  it("preserves the execute receiver for both return forms", async () => {
    const source = { inputSchema, contextSchema, value: 12, execute(this: { value: number }) { return this.value; } };
    const wrapped = asqavGuard(source, { agent: agent() });
    wrapped.value = 13;
    expect(await collect(executeTool({ tool: wrapped, input: { n: 0 }, options: execOptions })))
      .toEqual([{ type: "final", output: 13 }]);
    const streamed = asqavStreamGuard({ ...source, async *execute(this: { value: number }) { yield this.value; } }, { agent: agent() });
    expect(await collect(streamed.execute.call({ value: 14 }))).toEqual([14]);
    expect(source.value).toBe(12);
  });

  it("preserves output inference for an actual scalar tool declaration", async () => {
    const scalar = tool({ inputSchema, contextSchema, execute: async ({ n }) => n });
    const guarded = asqavGuard(scalar, { agent: agent() });
    expectTypeOf<InferToolOutput<typeof guarded>>().toEqualTypeOf<number>();
    expect(await collect(executeTool({ tool: guarded, input: { n: 2 }, options: execOptions })))
      .toEqual([{ type: "final", output: 2 }]);
  });

  it("keeps unknown stream outputs unknown for broad tool declarations", async () => {
    const broad: AiTool = { async *execute() { yield "value"; } };
    const guarded = asqavStreamGuard(broad, { agent: agent() });
    expectTypeOf<ReturnType<NonNullable<typeof guarded.execute>>>()
      .toEqualTypeOf<AsyncGenerator<unknown, void, unknown>>();
    expect(await collect(guarded.execute!({}, {}))).toEqual(["value"]);
    const unknownOutput: Tool<{ n: number }, unknown, { tenant: string }> = {
      inputSchema, contextSchema, outputSchema: z.unknown(),
      async *execute() { yield "unknown value"; },
    };
    const streamed = asqavStreamGuard(unknownOutput, { agent: agent() });
    expectTypeOf<ReturnType<NonNullable<typeof streamed.execute>>>()
      .toEqualTypeOf<AsyncGenerator<unknown, void, unknown>>();
  });

  it("preserves provider tools and optional execute types", () => {
    const provider: Tool<{ n: number }, number, { tenant: string }> = { inputSchema, contextSchema, outputSchema: z.number() };
    const guarded = asqavStreamGuard(provider, { agent: agent() });
    expect(guarded).toBe(provider);
    expectTypeOf(guarded.execute).toBeNullable();
  });
});
