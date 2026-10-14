import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { realpathSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { runCommand, scrubbedEnvironment, type CommandResult } from "./commands.js";
import { NectarError } from "./errors.js";
import type { BranchSource } from "./types.js";

const PINNED: Array<[string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.commitGraph", "false"],
  ["advice.graftFileDeprecated", "false"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["submodule.recurse", "false"],
  ["diff.ignoreSubmodules", "all"],
  ["protocol.allow", "never"],
  ...["ext", "file", "ssh", "git", "http", "https"].map((name): [string, string] => [`protocol.${name}.allow`, "never"]),
];

function isolatedEnvironment(settings: Array<[string, string]>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_GRAFT_FILE = "/dev/null";
  env.GIT_ALLOW_PROTOCOL = "none";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

async function repoOverrides(cwd: string): Promise<Array<[string, string]>> {
  const listed = await runCommand("git", ["config", "-z", "--show-scope", "--list"], { cwd, env: isolatedEnvironment(PINNED) });
  if (listed.exitCode !== 0) {
    if (/not in a git directory|not a git repository/i.test(listed.stderr)) return [];
    throw new NectarError("E_CHECKOUT", `Could not read git config in ${cwd}: ${listed.stderr.trim()}`);
  }
  const fields = listed.stdout.split("\0");
  const overrides: Array<[string, string]> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const entry = fields[index + 1] ?? "";
    const newline = entry.indexOf("\n");
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? "true" : entry.slice(newline + 1);
    const lower = key.toLowerCase();
    if (lower === "extensions.partialclone" || (/^remote\..+\.promisor$/.test(lower) && value.toLowerCase() !== "false")) {
      throw new NectarError("E_CHECKOUT", `${cwd} is a partial clone; publish a full clone, since Nectar never fetches missing objects`);
    }
    const filter = /^filter\.(.+)\.[^.]+$/s.exec(key);
    if (filter?.[1] !== undefined) {
      for (const setting of ["smudge", "clean", "process"]) overrides.push([`filter.${filter[1]}.${setting}`, ""]);
      overrides.push([`filter.${filter[1]}.required`, "false"]);
    }
    const hook = /^hook\.(.+)\.[^.]+$/s.exec(key);
    if (hook?.[1] !== undefined) overrides.push([`hook.${hook[1]}.command`, "true"]);
  }
  return overrides;
}

export async function runGit(args: string[], cwd: string): Promise<CommandResult> {
  const env = isolatedEnvironment([...PINNED, ...(await repoOverrides(cwd))]);
  return runCommand("git", ["--no-pager", ...args], { cwd, env });
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.exitCode !== 0) {
    throw new NectarError("E_CHECKOUT", result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export async function resolveRepo(input: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], path.resolve(input));
}

export async function sameRepository(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const [left, right] = await Promise.all(
      [a, b].map(async (dir) => git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir)),
    );
    return left === right;
  } catch {
    return false;
  }
}

export async function removeWorktree(repo: string, worktree: string): Promise<boolean> {
  const result = await runGit(["worktree", "remove", "--force", worktree], repo);
  return result.exitCode === 0;
}

export async function currentBranch(repo: string): Promise<string> {
  const branch = await git(["branch", "--show-current"], repo);
  if (!branch) throw new NectarError("E_CHECKOUT", "Detached HEAD requires --branch <name>");
  return branch;
}

export interface BranchSlot {
  branch: string;
  source: BranchSource;
  commit?: string;
}

const SESSION_SLOT_MAX = 40;

export function sessionSlot(session: string | undefined): string | undefined {
  if (session === undefined) return undefined;
  const slug = session
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SESSION_SLOT_MAX)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? undefined : `cell-${slug}`;
}

export async function resolveBranch(repo: string, explicit?: string, session?: string): Promise<BranchSlot> {
  if (explicit !== undefined) return { branch: explicit, source: "flag" };
  const current = await git(["branch", "--show-current"], repo);
  if (current) return { branch: current, source: "head" };
  const commit = await git(["rev-parse", "--verify", "HEAD^{commit}"], repo);
  const listed = await git(
    ["for-each-ref", "--contains", commit, "--format=%(refname)%00%(objectname)%00%(symref)", "refs/heads", "refs/remotes"],
    repo,
  );
  const candidates = listed
    .split("\n")
    .map((line) => line.split("\0"))
    .filter(([ref, , symref]) => ref !== undefined && ref !== "" && !symref)
    .map(([ref = "", object]) => {
      const local = ref.startsWith("refs/heads/");
      const branch = local ? ref.slice("refs/heads/".length) : ref.split("/").slice(3).join("/");
      return { branch, rank: (object === commit ? 0 : 2) + (local ? 0 : 1) };
    })
    .filter((candidate) => candidate.branch !== "" && candidate.branch !== "HEAD")
    .sort((a, b) => a.rank - b.rank || (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
  const chosen = candidates[0];
  if (chosen !== undefined) return { branch: chosen.branch, source: "contains", commit };
  const slot = sessionSlot(session);
  if (slot !== undefined) return { branch: slot, source: "session", commit };
  return { branch: `detached-${commit.slice(0, 8)}`, source: "detached", commit };
}

export function normalizeRemote(url: string, repo: string): string {
  const raw = url.trim().replace(/\/+$/, "");
  const hosted = (host: string, location: string): string =>
    `${host.toLowerCase()}/${location.replace(/^\/+/, "").replace(/^~\/?/, "").replace(/\.git$/i, "").replace(/\/+$/, "")}`;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]*)(?::\d+)?(\/.*)?$/i.exec(raw);
  let local = raw;
  if (scheme !== null) {
    if (scheme[1]?.toLowerCase() !== "file") return hosted(scheme[2] ?? "", scheme[3] ?? "");
    local = decodeURIComponent(scheme[3] ?? "/");
  } else {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.*)$/.exec(raw);
    if (scp !== null && !raw.startsWith(".")) return hosted(scp[1] ?? "", scp[2] ?? "");
  }
  const resolved = path.resolve(repo, local.replace(/\/\.git$/, "") || "/");
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export interface SourceIdentity {
  origin?: string;
  roots: string[];
}

export async function sourceIdentity(repo: string, ref: string): Promise<SourceIdentity> {
  if (ref.startsWith("-")) throw new NectarError("E_CHECKOUT", `Ref '${ref}' is not a valid ref name`);
  const remote = await runGit(["config", "--get", "remote.origin.url"], repo);
  const roots = (await git(["rev-list", "--max-parents=0", `${ref}^{commit}`, "--"], repo)).split("\n").filter(Boolean).sort();
  const url = remote.exitCode === 0 ? remote.stdout.trim() : "";
  return { ...(url ? { origin: normalizeRemote(url, repo) } : {}), roots };
}

export async function resolveCommit(repo: string, branch: string): Promise<string> {
  // spawn() means no shell injection, but a branch beginning with '-' would still
  // be argument-smuggled into git as an option.
  if (branch.startsWith("-")) throw new NectarError("E_CHECKOUT", `Branch '${branch}' is not a valid ref name`);
  return git(["rev-parse", `${branch}^{commit}`], repo);
}

export async function archiveCommit(repo: string, commit: string, maxBytes: number): Promise<Buffer> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new NectarError("E_CHECKOUT", `'${commit}' is not a commit id`);
  const env = isolatedEnvironment([...PINNED, ...(await repoOverrides(repo))]);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", "archive", "--format=tar", commit], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        reject(new NectarError("E_USAGE", `git archive of ${repo} is larger than ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new NectarError("E_CHECKOUT", Buffer.concat(errors).toString().trim() || `git archive ${commit} failed`));
    });
  });
}

export async function commitTree(repo: string, branch: string, message: string): Promise<void> {
  if (branch.startsWith("-")) throw new NectarError("E_CHECKOUT", `Branch '${branch}' is not a valid ref name`);
  if (!(await maybeFile(path.join(repo, ".git")))) await git(["init", "-q"], repo);
  await git(["check-ref-format", "--branch", branch], repo);
  await git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], repo);
  await git(["add", "-A", "-f", "--", "."], repo);
  await git(["-c", "user.name=nectar", "-c", "user.email=nectar@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", message], repo);
}

export async function shortCommit(repo: string): Promise<string> {
  return git(["rev-parse", "--short=8", "HEAD"], repo);
}

export async function prepareWorktree(options: {
  repo: string;
  branch: string;
  commit: string;
  destination: string;
  borrowed?: string;
  preserve?: string[];
}): Promise<{ worktree: string; borrowed: boolean; commit: string }> {
  if (options.borrowed !== undefined) {
    const worktree = path.resolve(options.borrowed);
    const root = await resolveRepo(worktree);
    if (root !== worktree) throw new NectarError("E_CHECKOUT", `Borrowed worktree must be its git root: ${worktree}`);
    const dirty = await git(["status", "--porcelain", "--ignore-submodules=all"], worktree);
    if (dirty) throw new NectarError("E_CHECKOUT", "Borrowed worktree is dirty; Nectar will never reset it");
    return { worktree, borrowed: true, commit: await shortCommit(worktree) };
  }

  let exists = true;
  try {
    await stat(options.destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
    else throw error;
  }
  if (!exists) {
    await git(["worktree", "add", "--detach", options.destination, options.commit], options.repo);
  } else {
    await git(["reset", "--hard", options.commit], options.destination);
    const preserve = [...(options.preserve ?? ["node_modules/"]), ".nectar/"];
    const cleanArgs = ["clean", "-fdx"];
    for (const entry of preserve) {
      const normalized = entry.replaceAll("\\", "/").replace(/^\.\/+/, "");
      if (
        !normalized ||
        normalized.startsWith("-") ||
        normalized.startsWith("/") ||
        normalized.split("/").includes("..")
      ) {
        throw new NectarError("E_CHECKOUT", `Unsafe worktree cache allowlist entry '${entry}'`);
      }
      cleanArgs.push("-e", normalized);
    }
    await git(cleanArgs, options.destination);
  }
  return { worktree: options.destination, borrowed: false, commit: await shortCommit(options.destination) };
}

async function maybeFile(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function lockfileHash(worktree: string): Promise<string | undefined> {
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const file = path.join(worktree, name);
    if (await maybeFile(file)) {
      return crypto.createHash("sha256").update(await readFile(file)).digest("hex");
    }
  }
  return undefined;
}

export async function installDependencies(worktree: string, previousHash?: string): Promise<string | undefined> {
  if (!(await maybeFile(path.join(worktree, "package.json")))) return undefined;
  const hash = await lockfileHash(worktree);
  if (hash !== undefined && hash === previousHash && (await maybeFile(path.join(worktree, "node_modules")))) return hash;

  let file = "npm";
  let args = ["install"];
  if (await maybeFile(path.join(worktree, "pnpm-lock.yaml"))) {
    file = "pnpm";
    args = ["install", "--frozen-lockfile"];
  } else if (await maybeFile(path.join(worktree, "package-lock.json"))) {
    args = ["ci"];
  } else if (await maybeFile(path.join(worktree, "yarn.lock"))) {
    file = "yarn";
    args = ["install", "--frozen-lockfile"];
  }
  const result = await runCommand(file, args, { cwd: worktree, env: scrubbedEnvironment() });
  if (result.exitCode !== 0) {
    throw new NectarError("E_INSTALL", `${file} ${args.join(" ")} failed`, {
      log_tail: [...result.stdout.split("\n"), ...result.stderr.split("\n")].filter(Boolean).slice(-40),
    });
  }
  return hash;
}
