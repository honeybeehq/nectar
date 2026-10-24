import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { cleanupTempDirs } from "./helpers.js";

process.env.NECTAR_SHARED_STATIC_ENTRY = fileURLToPath(new URL("../dist/shared-static.js", import.meta.url));
process.env.NECTAR_TAILSCALE_SOCKET = "/nonexistent/nectar-test/tailscaled.sock";

afterAll(async () => {
  await cleanupTempDirs();
});
