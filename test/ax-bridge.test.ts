import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startAxBridge, type AxBridge } from "../src/ax-bridge.js";
import { fakeExecutable, tempDir } from "./helpers.js";

const bridges: AxBridge[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    bridge.child.kill("SIGKILL");
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
  }
});

const SNAPSHOT = `{"screen":{"width":402,"height":874},"elements":[{"id":"0.0","path":"0.0","label":"tap me","value":"","role":"button","type":"Button","enabled":true,"frame":{"x":1,"y":2,"width":3,"height":4}}]}`;

async function readFirstEvent(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    const match = buffer.match(/data: (.*)\n\n/);
    if (match) {
      await reader.cancel();
      return match[1] as string;
    }
  }
  throw new Error("no SSE event received");
}

describe("ax bridge", () => {
  it("streams helper snapshots as SSE and reports health", async () => {
    const directory = await tempDir("ax");
    const helper = await fakeExecutable(
      directory,
      "helper",
      `printf '%s\\n' '${SNAPSHOT}'\nwhile :; do sleep 1; done`,
    );
    const bridge = await startAxBridge({ pid: process.pid, port: 0, helper });
    bridges.push(bridge);
    const port = (bridge.server.address() as AddressInfo).port;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      ok: boolean;
      pid: number;
    };
    expect(health).toMatchObject({ ok: true, pid: process.pid });
    expect(JSON.parse(await readFirstEvent(`http://127.0.0.1:${port}/ax`))).toMatchObject({
      screen: { width: 402 },
      elements: [{ type: "Button", label: "tap me" }],
    });
  });

  it("surfaces helper trust errors in /health", async () => {
    const directory = await tempDir("ax-err");
    const helper = await fakeExecutable(
      directory,
      "helper",
      `printf '{"error":"ax-not-trusted"}\\n'\nwhile :; do sleep 1; done`,
    );
    const bridge = await startAxBridge({ pid: process.pid, port: 0, helper });
    bridges.push(bridge);
    const port = (bridge.server.address() as AddressInfo).port;
    let health: { ok: boolean; error: string | null } = { ok: true, error: null };
    const deadline = Date.now() + 3_000;
    while (health.error === null && Date.now() < deadline) {
      health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as typeof health;
      if (health.error === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(health.ok).toBe(false);
    expect(health.error).toContain("ax-not-trusted");
  });
});
