import os from "node:os";
import type { EnvRecord, PreviewCreator, Publisher } from "./types.js";

// Publisher session fields are claims, even when WhoIs authenticates the node.
export function publisherCreator(publisher: Publisher): PreviewCreator | null {
  const session = publisher.hive_session ?? publisher.hive_bee;
  return session ? { session_id: session, node: publisher.node_name ?? publisher.node ?? os.hostname(), verified: false } : null;
}

// Do not upgrade a stored claim based on a caller-supplied verification flag.
export function previewCreator(record: EnvRecord): PreviewCreator | null {
  const creator = record.creator;
  return creator && typeof creator.session_id === "string" && creator.session_id.length > 0
    ? { session_id: creator.session_id, node: typeof creator.node === "string" ? creator.node : null, verified: false }
    : null;
}
