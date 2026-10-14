import path from "node:path";
import { describe, expect, it } from "vitest";
import { unitSpec } from "../src/daemon-unit.js";
import { getPaths } from "../src/paths.js";
import { MAC_APP_TAILSCALE, resolveTailscale } from "../src/tailscale.js";

function only(...present: string[]): (file: string) => boolean {
  return (file) => present.includes(file);
}

describe("resolveTailscale", () => {
  const PATH = ["/usr/bin", "/bin"].join(path.delimiter);

  it("prefers NECTAR_TAILSCALE_BIN over everything else", () => {
    expect(resolveTailscale({ env: { PATH, NECTAR_TAILSCALE_BIN: "/custom/tailscale" }, executable: only("/usr/bin/tailscale", MAC_APP_TAILSCALE) })).toEqual({
      path: "/custom/tailscale",
      source: "env",
      searched: [],
    });
  });

  it("uses tailscale on PATH before the app bundle", () => {
    expect(resolveTailscale({ env: { PATH }, executable: only("/bin/tailscale", MAC_APP_TAILSCALE) })).toMatchObject({ path: "/bin/tailscale", source: "path" });
  });

  it("falls back to the macOS app bundle when tailscale is not on PATH", () => {
    const found = resolveTailscale({ env: { PATH }, executable: only(MAC_APP_TAILSCALE, "/opt/homebrew/bin/tailscale") });
    expect(found).toEqual({
      path: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      source: "app-bundle",
      searched: ["/usr/bin/tailscale", "/bin/tailscale", MAC_APP_TAILSCALE],
    });
  });

  it("then tries Homebrew and the standalone install, in that order", () => {
    expect(resolveTailscale({ env: { PATH }, executable: only("/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale") })).toMatchObject({
      path: "/opt/homebrew/bin/tailscale",
      source: "homebrew",
    });
    expect(resolveTailscale({ env: { PATH }, executable: only("/usr/local/bin/tailscale") })).toMatchObject({ path: "/usr/local/bin/tailscale", source: "standalone" });
  });

  it("reports none with a bare command name when nothing is found", () => {
    expect(resolveTailscale({ env: {}, executable: only() })).toEqual({
      path: "tailscale",
      source: "none",
      searched: [MAC_APP_TAILSCALE, "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"],
    });
  });

  it("ignores an empty NECTAR_TAILSCALE_BIN", () => {
    expect(resolveTailscale({ env: { PATH, NECTAR_TAILSCALE_BIN: "" }, executable: only(MAC_APP_TAILSCALE) })).toMatchObject({ source: "app-bundle" });
  });
});

describe("daemon unit tailscale pin", () => {
  const paths = getPaths("/home/u/.nectar");

  it("pins NECTAR_TAILSCALE_BIN to the app bundle when tailscale is not on PATH", () => {
    const spec = unitSpec(paths, "darwin", { env: { PATH: "/usr/bin" }, executable: only(MAC_APP_TAILSCALE) });
    expect(spec.env.NECTAR_TAILSCALE_BIN).toBe(MAC_APP_TAILSCALE);
  });

  it("leaves NECTAR_TAILSCALE_BIN unset when tailscale is on PATH", () => {
    const spec = unitSpec(paths, "darwin", { env: { PATH: "/usr/bin" }, executable: only("/usr/bin/tailscale", MAC_APP_TAILSCALE) });
    expect(spec.env).not.toHaveProperty("NECTAR_TAILSCALE_BIN");
  });
});
