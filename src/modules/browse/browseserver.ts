import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { BLOCKED_ORIGINS, type VisionMode } from "./browserules.ts";
import { settings } from "../../core/settings.ts";
import { instancePaths } from "../../core/convpaths.ts";

// Is browsing set up, and how the browser server is started (the browse sub-task: browse.ts; its guard: browseguard.ts).

// ---- is browsing set up? ----

// The pinned server. `npm install` brings it (a dependency, exact version); `npm run setup:browse` downloads the browser into
// instance/browse/browsers (not a global location). Doctor and the tool report what is missing, in words.
export const PLAYWRIGHT_MCP_VERSION = "0.0.83";
const BROWSERS = () => instancePaths().browsers;

function serverCli(): string | undefined {
  try {
    return join(dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js");
  } catch {
    return undefined;
  }
}
function findBrowser(): string | undefined {
  if (settings.browseBrowserPath) return existsSync(settings.browseBrowserPath) ? settings.browseBrowserPath : undefined;
  try {
    for (const d of readdirSync(BROWSERS()).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of readdirSync(join(BROWSERS(), d))) {
        const exe = join(BROWSERS(), d, sub, "chrome-headless-shell");
        if (existsSync(exe)) return exe;
      }
    }
  } catch {
    // not installed
  }
  return undefined;
}
// The headless build announces itself as "HeadlessChrome" in its user agent, which several train and booking sites (SBB, Omio, Eurostar)
// turn away on sight. The browser is the same Chromium either way, so it is presented as the plain desktop Chrome of the same version.
// Nothing else is changed: no fingerprint, no script, no behaviour (a site that blocks automated browsers still does).
export function desktopUserAgent(exe: string, run: (exe: string) => string = (e) => execFileSync(e, ["--version"], { encoding: "utf8", timeout: 5000 })): string | undefined {
  try {
    const v = /(\d+)\.\d+\.\d+\.\d+/.exec(run(exe))?.[0];
    return v ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v.split(".")[0]}.0.0.0 Safari/537.36` : undefined;
  } catch {
    return undefined;
  }
}
export type BrowseStatus = { ok: true; cli: string; exe: string } | { ok: false; reason: string };
export function browseStatus(): BrowseStatus {
  const cli = serverCli();
  if (!cli || !existsSync(cli)) return { ok: false, reason: `the browser server is not installed (run npm install; it pins @playwright/mcp ${PLAYWRIGHT_MCP_VERSION})` };
  const exe = findBrowser();
  if (!exe) return { ok: false, reason: "the browser is not downloaded (run npm run setup:browse)" };
  return { ok: true, cli, exe };
}

// The MCP server of the browser, for the browse run's options only. Isolated (in memory: no cookies, no logins, nothing saved),
// headless, no service workers, no images to the model, private ranges blocked by name (a best-effort extra) and, the real network veto, the run's egress proxy
// (the guard's address check on what the worker asks for comes first). Started with a minimal environment, in a folder of its own that is removed afterwards.
export function browserServer(st: Extract<BrowseStatus, { ok: true }>, outDir: string, ua: string | undefined = desktopUserAgent(st.exe), vision: { mode: VisionMode; cdpPort?: number; proxyPort?: number; unproxiedForTest?: true } = { mode: "off" }): McpServerConfig {
  // An ordinary language and the time zone of this machine, so the page sees what a browser on this computer would send.
  const configFile = join(outDir, "browser-config.json");
  // vision click mode only: the browser also listens on a debugging port on loopback, for the guard's own lookup of what is under a point (browsecdp.ts).
  // Every connection of the browser goes through the run's egress proxy (browseproxy.ts: public addresses only, on the ports a page may use). `<-loopback>` takes away
  // Chromium's default bypass for localhost, so a page cannot reach the owner's own machine around the proxy; the debugging port is reached by code, not by the browser.
  // No proxy, no browser: a launch without the egress filter is refused (only a test may say it does without, `unproxiedForTest`).
  if (!vision.proxyPort && !vision.unproxiedForTest) throw new Error("the egress proxy is missing: the browser is not started without it");
  // WebRTC (UDP to LAN addresses, outside any proxy) is limited to proxied traffic and QUIC (UDP) is off, so nothing but TCP through the proxy leaves the browser.
  const args = [...(vision.proxyPort ? [`--proxy-server=http://127.0.0.1:${vision.proxyPort}`, "--proxy-bypass-list=<-loopback>"] : []), "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic", ...(vision.cdpPort ? [`--remote-debugging-port=${vision.cdpPort}`] : [])];
  const launchOptions = { launchOptions: { args } };
  writeFileSync(configFile, JSON.stringify({ browser: { ...launchOptions, contextOptions: { locale: settings.browseLocale, timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone } } }));
  return {
    type: "stdio",
    command: process.execPath,
    args: [st.cli, ...(ua ? ["--user-agent", ua] : []), "--config", configFile, "--headless", "--isolated", "--block-service-workers", ...(vision.mode === "click" ? ["--caps", "vision"] : []), "--image-responses", vision.mode === "off" ? "omit" : "allow", "--file-paths", "absolute", "--timeout-navigation", "30000", "--viewport-size", "1280x800", "--output-dir", outDir, "--executable-path", st.exe, "--blocked-origins", BLOCKED_ORIGINS.join(";")],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "", PLAYWRIGHT_BROWSERS_PATH: BROWSERS() },
  };
}
