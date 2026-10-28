import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const [file, ...args] = process.argv.slice(2);
if (file === undefined) process.exit(1);
let exited = false;
let exitCode = 1;
let timer: NodeJS.Timeout | undefined;
let members: number[] = [];
function linuxMember(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
    return Number(fields[2]) === process.pid && fields[0] !== "Z";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function hasMembers(): boolean {
  if (process.platform === "linux") {
    members = members.filter(linuxMember);
    if (members.length > 0) return true;
    members = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number).filter((pid) => pid !== process.pid && linuxMember(pid));
    return members.length > 0;
  }
  const listed = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 2_000 });
  if (listed.status !== 0) return true;
  return listed.stdout.split("\n").some((line) => {
    const [pid, pgid, state] = line.trim().split(/\s+/);
    return Number(pgid) === process.pid && Number(pid) !== process.pid && Number(pid) !== listed.pid && !state?.startsWith("Z");
  });
}
function check(): void {
  try {
    if (exited && !hasMembers()) process.exit(exitCode);
  } catch {
    return;
  }
}
function watch(): void {
  if (timer === undefined) timer = setInterval(check, 1_000);
  check();
}
process.on("SIGTERM", watch);
process.on("SIGINT", watch);
const child = spawn(file, args, { stdio: "inherit" });
child.on("error", (error) => { console.error(`Nectar: could not launch ${file}: ${error.message}`); exited = true; watch(); });
child.on("exit", (code) => { exited = true; exitCode = code ?? 1; watch(); });
