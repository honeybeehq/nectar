import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
const legacy = process.argv.includes("--legacy");
const root = path.resolve(
  "test/fixtures/.runs",
  `t1-${legacy ? "legacy" : "expanded"}-${Date.now()}`,
);
console.log(JSON.stringify({ event: "start", root, legacy }));
const state = path.join(root, "state");
await mkdir(state, { recursive: true });
const socketDir = `/tmp/nectar-t1-${process.pid}`;
await mkdir(socketDir, { mode: 0o700 });
const socket = path.join(socketDir, "nectard.sock");
const env = { ...process.env, NECTAR_HOME: state, NECTAR_SOCKET: socket };
const cli = path.resolve("dist/cli.js");
const config = {
  upstream_port_start: 24000,
  upstream_port_end: legacy ? 24099 : 65535,
  tailnet_port_start: 25000,
  tailnet_port_end: legacy ? 25099 : 65535,
  remote: { listen: false },
};
await writeFile(path.join(state, "nectar.json"), JSON.stringify(config));
const site = path.join(root, "site");
await mkdir(site, { recursive: true });
await writeFile(
  path.join(site, "index.html"),
  "<h1>T1 isolated preview fixture</h1>",
);
const log = await import("node:fs").then((fs) =>
  fs.openSync(path.join(root, "daemon.log"), "a"),
);
const daemon = spawn(
  process.execPath,
  [cli, "daemon", "run", "--interval", "250ms"],
  { env, stdio: ["ignore", log, log] },
);
async function run(args) {
  return await new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, ...args, "--json"], { env });
    let out = "",
      err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("exit", (code) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ ok: false, code, out, err });
      }
    });
  });
}
const names = [];
const results = [];
try {
  for (let i = 0; i < 100; i++) {
    try {
      await import("node:fs/promises").then((fs) => fs.stat(socket));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const hello = JSON.parse(
    execFileSync(
      "curl",
      [
        "--fail",
        "--silent",
        "--unix-socket",
        socket,
        "http://nectard/v1/hello",
      ],
      { encoding: "utf8" },
    ),
  );
  if (hello.nectar_home !== state || hello.pid !== daemon.pid)
    throw Error("wrong daemon");
  console.log(JSON.stringify({ event: "daemon_hello", ...hello }));
  async function measure(record) {
    const pid = record.serve.pid;
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return {
      name: record.name,
      pid,
      rss_kib: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]),
      fd_count: (await readdir(`/proc/${pid}/fd`)).length,
      upstream: record.serve.upstream_port,
      proxy: record.serve.proxy_port,
      tailnet: record.serve.tailnet_port,
      disk_bytes: Number(
        execFileSync("du", ["-sb", record.worktree], {
          encoding: "utf8",
        }).split(/\s/)[0],
      ),
    };
  }
  for (let i = 0; i < (legacy ? 55 : 105); i++) {
    let r;
    for (let attempt = 0; attempt < 30; attempt++) {
      r = await run([
        "publish",
        site,
        "--mode",
        "static",
        "--local",
        "--name",
        `t1-${process.pid}-${i}`,
      ]);
      if (r.error?.code !== "E_BUSY") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!r.ok) {
      console.log(
        JSON.stringify({ event: "first_failure", index: i, error: r.error }),
      );
      break;
    }
    names.push(r.result.env);
    const response = await fetch(r.result.urls.local);
    if (
      response.status !== 200 ||
      (await response.text()) !== "<h1>T1 isolated preview fixture</h1>"
    )
      throw Error("URL failed");
    results.push(r.result);
    for (let attempt = 0; attempt < 50; attempt++) {
      const record = JSON.parse(
        await readFile(
          path.join(state, "envs", r.result.env + ".json"),
          "utf8",
        ),
      );
      if (record.serve?.proxy_port) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log(
      JSON.stringify({
        event: "published",
        index: i,
        env: r.result.env,
        urls: r.result.urls,
      }),
    );
  }
  assert.equal(names.length, legacy ? 50 : 105);
  await new Promise((r) => setTimeout(r, 3000));
  const records = await Promise.all(
    names.map((n) =>
      readFile(path.join(state, "envs", n + ".json"), "utf8").then(JSON.parse),
    ),
  );
  console.log(
    JSON.stringify({
      event: "measurement",
      count: records.length,
      first: await measure(records[0]),
      last: await measure(records.at(-1)),
      proxy_count: records.filter((r) => r.serve.proxy_port).length,
      daemon_rss_kib: Number(
        /^VmRSS:\s+(\d+)/m.exec(
          await readFile(`/proc/${daemon.pid}/status`, "utf8"),
        )?.[1],
      ),
      state_disk_bytes: Number(
        execFileSync("du", ["-sb", state], { encoding: "utf8" }).split(/\s/)[0],
      ),
    }),
  );
  await writeFile(
    path.join(root, "results.json"),
    JSON.stringify({ results, records }, null, 2),
  );
  if (!legacy) {
    const dev = path.join(root, "dev");
    await mkdir(dev);
    await writeFile(
      path.join(dev, "server.mjs"),
      `import http from 'node:http';http.createServer((req,res)=>res.end('T1 small dev server')).listen(Number(process.env.PORT),'127.0.0.1');`,
    );
    await writeFile(
      path.join(dev, "nectar.toml"),
      'name = "t1-dev"\n[web]\nserve = "exec node server.mjs"\n',
    );
    for (const args of [
      ["init", "--quiet", dev],
      ["-C", dev, "add", "."],
      [
        "-C",
        dev,
        "-c",
        "user.name=T1 fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Fixture",
      ],
    ])
      execFileSync("git", args);
    let r;
    for (let attempt = 0; attempt < 30; attempt++) {
      r = await run([
        "publish",
        dev,
        "--local",
        "--name",
        `t1-dev-${process.pid}`,
      ]);
      if (r.error?.code !== "E_BUSY") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!r.ok) throw Error(JSON.stringify(r));
    names.push(r.result.env);
    const body = await fetch(r.result.urls.local).then((r) => r.text());
    if (body !== "T1 small dev server") throw Error(body);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const record = JSON.parse(
      await readFile(path.join(state, "envs", r.result.env + ".json"), "utf8"),
    );
    console.log(
      JSON.stringify({
        event: "dev_measurement",
        ...(await measure(record)),
        urls: r.result.urls,
      }),
    );
  }
} finally {
  for (const n of names)
    console.log(
      JSON.stringify({
        event: "cleanup",
        env: n,
        result: await run(["stop", n]),
      }),
    );
  daemon.kill("SIGTERM");
  await new Promise((r) => daemon.once("exit", r));
}
