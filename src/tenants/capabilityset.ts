import { baseUrlProblem, intakeToolsFor } from "../intake/intakelinks.ts";
import { googleReady, settings } from "../core/settings.ts";
import { CAPABILITIES, FRIEND_CAPABILITIES, OWNER_ID, OWNER_ONLY, tenantContext, type Capability, type TenantRecord } from "./tenants.ts";

// What a person has: the derivation of a capability set, which nothing stores (policy/capabilities.ts turns it into tools, skills and the answer to "may this conversation
// use it now"). It lives here, not in policy/, because the admin's list, the connection summary and the intake page read it as well.

// What the instance switches off in .env for everybody (the owner included): a feature that is off has no tools, no skill and no loop.
const SWITCHES: ReadonlyArray<readonly [Capability, () => boolean]> = [
  ["browse", () => settings.browse],
  ["weather", () => settings.weather],
  ["draw", () => settings.draw],
  ["dream", () => settings.dream],
  ["wake", () => settings.wakeups],
];

// The pure part: what is available to the person (the owner: everything; a friend: everything but OWNER_ONLY; a group: its fixed set), less what the credential cannot give, what is not set up yet, what the instance has switched off and what the person turned off
// for herself. Every step only takes away. `login`: the owner's conversation, on the instance's own login.
export function resolveCapabilities(granted: readonly Capability[], o: { login?: boolean; own?: { browse?: boolean; voice?: boolean; groups?: boolean } } = {}): ReadonlySet<Capability> {
  const caps = new Set(granted);
  if (!intakeToolsFor(granted).length) caps.delete("intake"); // its tools need INTAKE_BASE_URL, a purpose and the capability for it (read before the login-only ones go)
  if (!o.login) {
    for (const c of OWNER_ONLY) caps.delete(c); // (everybody else runs without the login's connectors, strictMcpConfig, so there is nothing to give)
    // Mail and calendar of a person on the instance key are her own Google (modules/google.ts): only with the `google` capability and an OAuth client set up.
    // (The owner's are her connectors, which need no OAuth client.)
    if (!caps.has("google") || !googleReady()) for (const c of ["google", "mail", "calendar"] as const) caps.delete(c);
    // Notion of a person on the instance key is her own, through the hosted Notion server (modules/notionhosted.ts): only with the `notion` capability and a page to sign in
    // on (INTAKE_BASE_URL). The owner's Notion is the connector, which no isolated run ever has (the `login` capability: capabilities.ts toolsFor).
    if (baseUrlProblem()) caps.delete("notion");
  }
  for (const [c, on] of SWITCHES) if (!on()) caps.delete(c);
  if (o.own?.browse === false) caps.delete("browse");
  if (o.own?.voice === false) caps.delete("voice");
  if (o.own?.groups === false) caps.delete("groups");
  return caps;
}

// What a person has, whatever her status: the owner everything, a friend everything but OWNER_ONLY (derived, never stored: a new capability reaches every friend), then the
// steps of resolveCapabilities (credential, readiness, instance switches, her own settings). The admin's `list` shows this.
export const capabilitiesOfRecord = (rec: TenantRecord): ReadonlySet<Capability> =>
  rec.id === OWNER_ID ? resolveCapabilities(CAPABILITIES, { login: true }) : resolveCapabilities(FRIEND_CAPABILITIES, { own: tenantContext(rec).config });
