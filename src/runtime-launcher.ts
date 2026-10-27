import { spawn, execFileSync } from "node:child_process";

const [file, ...args] = process.argv.slice(2);
if (file === undefined) process.exit(1);
let exited = false;
let exitCode = 1;
let polling = false;
const check = (): void => {
  if (polling) return;
  polling = true;
  const timer = setInterval(() => {
    try {
      const listed = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 2_000 });
      const others = listed.split("\n").some((line) => {
        const [pid, pgid, state] = line.trim().split(/\s+/);
        return Number(pgid) === process.pid && Number(pid) !== process.pid && !state?.startsWith("Z");
      });
      if (exited && !others) {
        clearInterval(timer);
        process.exit(exitCode);
      }
    } catch {
      polling = true;
    }
  }, 50);
};
process.on("SIGTERM", check);
process.on("SIGINT", check);
const child = spawn(file, args, { stdio: "inherit" });
child.on("error", () => { exited = true; check(); });
child.on("exit", (code) => { exited = true; exitCode = code ?? 1; check(); });
