import { loaded, registered } from "../modules/index.ts";

// What an unattended job (a run profile, profiles.ts) can SEE of the connectors. Every tool schema the model sees is sent on every model call, and a fresh
// session pays for the whole list once more, so a job that reads the calendar should not carry the mail client's. A profile names what it needs as
// "provider:action" (the manifest's words: `calendar:read`, `notion:read`) and this resolves it to tool names through the rows of the loaded modules.
// It only HIDES (the SDK's disallowedTools, like policy.ts hiddenTools): what the job may do is still decided by the code floor, the judge and the owner.

// (Only the owner's connectors: a friend's own connection is another module.)
export const toolsFor = (specs: readonly string[]): ReadonlySet<string> =>
  new Set(loaded().filter((m) => m.connection.kind === "connector").flatMap((m) => m.rows).filter((r) => specs.includes(`${r.provider}:${r.action}`)).map((r) => r.tool));

// Everything under an MCP server that `allow` does not hold: a connector with no allowed tool is hidden whole (its server name, as hiddenConnectors does), the
// others by name (the rows of every module in the code, plus the tools runs have seen: a tool a connector adds later is hidden by the run after the first
// that saw it). A tool of a server nobody knows is hidden when it has been seen.
export function hiddenOutside(allow: ReadonlySet<string>, seen: readonly string[]): string[] {
  const connectors = registered().flatMap((m) => (m.connection.kind === "connector" ? [m.connection.prefix] : []));
  const whole = connectors.filter((p) => ![...allow].some((t) => t.startsWith(p))).map((p) => p.replace(/__$/, ""));
  const names = [...registered().flatMap((m) => m.rows.map((r) => r.tool)), ...seen].filter((t) => t.startsWith("mcp__") && !allow.has(t));
  return [...new Set([...whole, ...names])];
}
