import path from "node:path";
import http from "node:http";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { startPackServer } from "../src/pack-server.js";
import { tempDir } from "./helpers.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function rawGet(port: number, requestPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: requestPath, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("read-only loopback pack server", () => {
  it("serves files, never lists directories, rejects traversal, and never follows symlinks", async () => {
    const state = await tempDir("pack-server");
    const root = path.join(state, "packs");
    const outside = path.join(state, "outside");
    await mkdir(path.join(root, "demo--main--desktop"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, "demo--main--desktop", "demo.testpack.zip"), "verified-pack");
    await writeFile(path.join(outside, "secret.txt"), "must-not-serve");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "linked-secret"));
    await symlink(outside, path.join(root, "linked-directory"));

    const server = await startPackServer(root, 0);
    servers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing server address");
    expect(address.address).toBe("127.0.0.1");

    expect(await rawGet(address.port, "/demo--main--desktop/demo.testpack.zip")).toEqual({ status: 200, body: "verified-pack" });
    expect((await rawGet(address.port, "/")).status).toBe(404);
    expect((await rawGet(address.port, "/demo--main--desktop/")).status).toBe(404);
    expect((await rawGet(address.port, "/%2e%2e/outside/secret.txt")).body).not.toContain("must-not-serve");
    expect((await rawGet(address.port, "/linked-secret")).status).toBe(404);
    expect((await rawGet(address.port, "/linked-directory/secret.txt")).status).toBe(404);
  });
});
