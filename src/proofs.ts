import { runCommand } from "./commands.js";
import type { EnvRecord } from "./types.js";

export const PROOF_GRACE_MS = 24 * 60 * 60_000;
export type PreviewProofState = { state: "waiting" } | { state: "terminal" } | { state: "unlinked" } | { state: "unknown"; reason: string };

export async function previewProofState(record: EnvRecord): Promise<PreviewProofState> {
  const command = process.env.NECTAR_PROOF_LOOKUP;
  if (!command) return { state: "unknown", reason: "NECTAR_PROOF_LOOKUP is not configured" };
  try {
    const result = await runCommand(command, [], {
      timeoutMs: 10_000,
      input: JSON.stringify({ version: 1, ref: record.ref, urls: record.urls }),
    });
    if (result.exitCode !== 0) return { state: "unknown", reason: `lookup exited ${result.exitCode}` };
    const response: unknown = JSON.parse(result.stdout);
    if (typeof response !== "object" || response === null || !("state" in response)) return { state: "unknown", reason: "invalid lookup response" };
    if (response.state === "waiting" || response.state === "terminal" || response.state === "unlinked") return { state: response.state };
    return { state: "unknown", reason: "lookup returned unknown state" };
  } catch (error) {
    return { state: "unknown", reason: error instanceof Error ? error.message : "lookup failed" };
  }
}
