import crypto from "node:crypto";
import path from "node:path";
import { access, readFile, stat } from "node:fs/promises";
import { runCommand, scrubbedEnvironment, type CommandResult } from "./commands.js";
import { NectarError } from "./errors.js";

const PINNED: Array<[string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
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

export async function resolveCommit(repo: string, branch: string): Promise<string> {
  // spawn() means no shell injection, but a branch beginning with '-' would still
  // be argument-smuggled into git as an option.
  if (branch.startsWith("-")) throw new NectarError("E_CHECKOUT", `Branch '${branch}' is not a valid ref name`);
  return git(["rev-parse", `${branch}^{commit}`], repo);
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
