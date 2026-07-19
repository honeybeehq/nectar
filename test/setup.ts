import { afterAll } from "vitest";
import { cleanupTempDirs } from "./helpers.js";

afterAll(async () => {
  await cleanupTempDirs();
});
