import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/commands.js";
import { parseConfig } from "../src/relayd.js";
import { tempDir } from "./helpers.js";

const SCRIPT = path.resolve("relay/install-relayd.sh");
const FILES = ["relayd-cli.js", "relayd.js", "localapi.js", "commands.js", "errors.js"];

async function fakeDist(): Promise<string> {
  const dist = await tempDir("relayd-dist");
  for (const file of FILES) await writeFile(path.join(dist, file), `// ${file}\n`);
  return dist;
}

describe("install-relayd.sh", () => {
  it("renders the units, config, admin shim and prune cron into a scratch root without touching the host", async () => {
    const root = await tempDir("relayd-root");
    const dist = await fakeDist();
    const run = await runCommand("bash", [SCRIPT, "nctr.site", "--root", root, "--dist", dist], { env: { ...process.env, NECTAR_RELAYD_NODE: process.execPath } });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toContain("scratch install rendered");
    for (const file of FILES) expect(existsSync(path.join(root, "opt/nectar-relayd", file))).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, "opt/nectar-relayd/package.json"), "utf8"))).toMatchObject({ type: "module" });
    const config = parseConfig(await readFile(path.join(root, "etc/nectar-relayd.json"), "utf8"));
    expect(config).toMatchObject({ domain: "nctr.site", allow: [], ungated: [], control: { port: 8450 }, verify: { port: 8451 }, routes_dir: "/etc/caddy/nctr-routes", reload: { stamp: "/var/lib/nectar-relayd/reload.stamp" } });
    const unit = await readFile(path.join(root, "etc/systemd/system/nectar-relayd.service"), "utf8");
    expect(unit).toContain(`ExecStart=${process.execPath} /opt/nectar-relayd/relayd-cli.js serve --config /etc/nectar-relayd.json`);
    for (const line of ["User=nectar-relayd", "NoNewPrivileges=yes", "ProtectSystem=strict", "ReadWritePaths=/etc/caddy/nctr-routes", "CapabilityBoundingSet="]) expect(unit).toContain(line);
    expect(await readFile(path.join(root, "etc/systemd/system/nectar-relayd-caddy-reload.path"), "utf8")).toContain("PathChanged=/var/lib/nectar-relayd/reload.stamp");
    expect(await readFile(path.join(root, "usr/local/bin/nectar-relay"), "utf8")).toContain("/opt/nectar-relayd/relayd-cli.js admin --config /etc/nectar-relayd.json \"$@\"");
    expect((await stat(path.join(root, "usr/local/bin/nectar-relay"))).mode & 0o777).toBe(0o755);
    expect(await readFile(path.join(root, "etc/cron.d/nctr-relay-prune"), "utf8")).toContain("/usr/local/bin/nectar-relay prune");
    expect((await stat(path.join(root, "etc/caddy/nctr-routes"))).mode & 0o7777).toBe(0o2750);
  });

  it("keeps an existing config and refuses a bad domain, a missing build or a relative root", async () => {
    const root = await tempDir("relayd-root");
    const dist = await fakeDist();
    const env = { ...process.env, NECTAR_RELAYD_NODE: process.execPath };
    await mkdir(path.join(root, "etc"), { recursive: true });
    await writeFile(path.join(root, "etc/nectar-relayd.json"), "{\"kept\": true}\n");
    expect((await runCommand("bash", [SCRIPT, "nctr.site", "--root", root, "--dist", dist], { env })).exitCode).toBe(0);
    expect(await readFile(path.join(root, "etc/nectar-relayd.json"), "utf8")).toBe("{\"kept\": true}\n");
    expect((await runCommand("bash", [SCRIPT, "nctr site; rm -rf /", "--root", root, "--dist", dist], { env })).exitCode).toBe(2);
    expect((await runCommand("bash", [SCRIPT, "nctr.site", "--root", root, "--dist", path.join(root, "nope")], { env })).exitCode).toBe(1);
    expect((await runCommand("bash", [SCRIPT, "nctr.site", "--root", "relative", "--dist", dist], { env })).exitCode).toBe(2);
    for (const disguised of ["//", "/./", "/tmp/.."]) expect((await runCommand("bash", [SCRIPT, "nctr.site", "--root", disguised, "--dist", dist], { env })).exitCode).toBe(2);
  });
});
