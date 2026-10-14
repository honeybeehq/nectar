import { afterAll } from "vitest";
import { cleanupTempDirs } from "./helpers.js";

process.env.NECTAR_TAILSCALE_SOCKET = "/nonexistent/nectar-test/tailscaled.sock";

afterAll(async () => {
  await cleanupTempDirs();
});
