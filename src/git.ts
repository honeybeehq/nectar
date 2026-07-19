import crypto from "node:crypto";
import path from "node:path";
import { access, readFile, stat } from "node:fs/promises";
import { runCommand, scrubbedEnvironment } from "./commands.js";
import { NectarError } from "./errors.js";

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runCommand("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new NectarError("E_CHECKOUT", result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export async function resolveRepo(input: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], path.resolve(input));
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
}): Promise<{ worktree: string; borrowed: boolean; commit: string }> {
  if (options.borrowed !== undefined) {
    const worktree = path.resolve(options.borrowed);
    const root = await resolveRepo(worktree);
    if (root !== worktree) throw new NectarError("E_CHECKOUT", `Borrowed worktree must be its git root: ${worktree}`);
    const dirty = await git(["status", "--porcelain"], worktree);
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
    await git(["clean", "-fdx", "-e", "node_modules/"], options.destination);
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
