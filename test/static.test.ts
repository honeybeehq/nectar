import path from "node:path";
import http from "node:http";
import type { Server } from "node:http";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { findStaticSite, stageStaticSite } from "../src/static-site.js";
import { startStaticServer } from "../src/static-server.js";
import { tempDir } from "./helpers.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
}

function rawGet(port: number, pathname: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on("error", reject);
  });
}

describe("static site detection", () => {
  it("finds index.html at the root first, then in common build directories", async () => {
    const root = await tempDir("static-root");
    await writeTree(root, { "index.html": "<h1>root</h1>", "dist/index.html": "<h1>dist</h1>" });
    expect(await findStaticSite(root)).toEqual({ source: root, root: path.join(root, "."), name: path.basename(root) });

    const built = await tempDir("static-built");
    await writeTree(built, { "src/main.ts": "", "build/index.html": "<h1>build</h1>" });
    expect((await findStaticSite(built))?.root).toBe(path.join(built, "build"));
  });

  it("accepts a single .html file and rejects everything else", async () => {
    const root = await tempDir("static-file");
    await writeTree(root, { "report.html": "<h1>r</h1>", "notes.txt": "x", "empty/readme.md": "" });
    expect(await findStaticSite(path.join(root, "report.html"))).toMatchObject({
      file: path.join(root, "report.html"),
      root,
      name: "report",
    });
    expect(await findStaticSite(path.join(root, "notes.txt"))).toBeUndefined();
    expect(await findStaticSite(path.join(root, "empty"))).toBeUndefined();
    expect(await findStaticSite(path.join(root, "missing"))).toBeUndefined();
  });
});

describe("static site staging", () => {
  it("copies regular files, skips .git/node_modules/symlinks, and swaps the previous copy", async () => {
    const source = await tempDir("static-source");
    await writeTree(source, {
      "index.html": "<h1>v1</h1>",
      "assets/app.css": "body{}",
      ".git/HEAD": "ref",
      "node_modules/x/index.js": "",
    });
    await symlink("/etc/hostname", path.join(source, "linked.txt"));
    const site = await findStaticSite(source);
    if (site === undefined) throw new Error("expected a site");
    const work = await tempDir("static-work");
    const destination = path.join(work, "site--static--web");

    const first = await stageStaticSite(site, destination);
    expect(first).toMatchObject({ files: 2, skippedLinks: 1 });
    expect(await readdir(destination)).toEqual(["assets", "index.html"]);
    expect((await stageStaticSite(site, destination)).hash).toBe(first.hash);

    await writeFile(path.join(source, "index.html"), "<h1>v2</h1>");
    const second = await stageStaticSite(site, destination);
    expect(second.hash).not.toBe(first.hash);
    expect(await readFile(path.join(destination, "index.html"), "utf8")).toBe("<h1>v2</h1>");
    expect(await readdir(work)).toEqual(["site--static--web"]);
  });

  it("stages a single file as index.html", async () => {
    const source = await tempDir("static-single");
    await writeTree(source, { "chart.html": "<svg/>", "other.html": "no" });
    const site = await findStaticSite(path.join(source, "chart.html"));
    if (site === undefined) throw new Error("expected a site");
    const destination = path.join(await tempDir("static-single-work"), "chart");
    expect(await stageStaticSite(site, destination)).toMatchObject({ files: 1 });
    expect(await readdir(destination)).toEqual(["index.html"]);
  });
});

describe("static server", () => {
  it("serves files with content types, index.html for directories, and nothing outside the root", async () => {
    const root = await tempDir("static-serve");
    await writeTree(root, {
      "index.html": "<h1>home</h1>",
      "app.js": "console.log(1)",
      "style.css": "body{}",
      "docs/index.html": "<h1>docs</h1>",
      "blob.bin": "x",
    });
    await symlink("/etc/hostname", path.join(root, "leak.txt"));
    const server = await startStaticServer(root, 0);
    servers.push(server);
    const port = (server.address() as { port: number }).port;

    const home = await rawGet(port, "/");
    expect(home).toMatchObject({ status: 200, body: "<h1>home</h1>" });
    expect(home.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect((await rawGet(port, "/app.js")).headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect((await rawGet(port, "/style.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
    expect((await rawGet(port, "/blob.bin")).headers["content-type"]).toBe("application/octet-stream");
    expect(await rawGet(port, "/docs/")).toMatchObject({ status: 200, body: "<h1>docs</h1>" });
    const redirect = await rawGet(port, "/docs?x=1");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.location).toBe("/docs/?x=1");
    expect((await rawGet(port, "/missing.html")).status).toBe(404);
    expect((await rawGet(port, "/leak.txt")).status).toBe(404);
    expect((await rawGet(port, "/../../etc/passwd")).status).toBe(404);
    expect((await rawGet(port, "/%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);
    const post = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
    expect(post.status).toBe(405);
  });
});
