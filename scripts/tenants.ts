// npm run tenants -- list | invite [note] | grant <id> <capability> | revoke <id> <capability> | timezone <id> <zone|default> | set-admin <id>: the administrator's terminal side of tenants
// (docs/SETUP.md "More than one person"). Local terminal only. This is the ONLY place the admin role and the capabilities change: no tool, no chat path,
// no model can reach them (test/tenants.test.ts walks every tool).
import { settings, signalIdentity } from "../src/core/settings.ts";
import { describeTenants } from "../src/tenants/tenanttools.ts";
import { CAPABILITIES, ensureOwner, grant, isCapability, mintInvite, revoke, setAdmin, setTimeZone } from "../src/tenants/tenants.ts";

const [cmd, arg, ...rest] = process.argv.slice(2);
const say = (l: string) => console.log(l);
const usage = `usage: npm run tenants -- list | invite [note] | grant <id> <capability> | revoke <id> <capability> | timezone <id> <zone|default> | set-admin <id>\ncapabilities: ${CAPABILITIES.join(", ")}`;

// The admin role is the way back in after a lock-out, so it works with TENANTS off too; everything about friends needs TENANTS=on.
if (cmd !== "set-admin" && !settings.tenants) {
  say("TENANTS is off. Set TENANTS=on in .env (and give the assistant its own Signal account) first; see docs/SETUP.md.");
  process.exit(1);
}
ensureOwner({ number: signalIdentity().ownerNumber, aci: signalIdentity().ownerAci });

if (cmd === "list") {
  const lines = describeTenants();
  say(lines.join("\n"));
  if (lines.length === 1) say("No tenants yet. Mint an invite: npm run tenants -- invite \"for Anna\" (or ask the assistant in your chat).");
} else if (cmd === "invite") {
  const made = mintInvite([arg, ...rest].filter(Boolean).join(" ") || undefined);
  say(made ? `Invite code: ${made.code}\nSingle use, valid until ${new Date(made.expiresAt).toLocaleString()}. She sends it to the assistant in a private Signal message.` : "Too many invite codes are open already.");
} else if ((cmd === "grant" || cmd === "revoke") && arg && rest[0]) {
  if (!isCapability(rest[0])) {
    say(`Not a capability: ${rest[0]}. ${CAPABILITIES.join(", ")}`);
    process.exit(1);
  }
  // Her Google tools are the `mail` and `calendar` capabilities through her `google` one (modules/google.ts): granting it grants the three, revoking it revokes only itself.
  const caps = cmd === "grant" && rest[0] === "google" ? (["google", "mail", "calendar"] as const) : ([rest[0]] as const);
  let rec = (cmd === "grant" ? grant : revoke)(arg, caps[0]);
  for (const c of caps.slice(1)) rec = rec && grant(arg, c);
  if (!rec) {
    say("No such tenant.");
    process.exit(1);
  }
  say(`${rec.id}: ${rec.capabilities.join(", ") || "no capabilities"}`);
} else if (cmd === "timezone" && arg && rest[0]) {
  // Her clock for the heartbeat run and the day her notes expire on (tenant.json "timeZone"); `default` goes back to the owner's, the Mac's.
  try {
    const rec = setTimeZone(arg, rest[0] === "default" ? undefined : rest[0]);
    say(rec ? `${rec.id}: time zone ${rest[0] === "default" ? "is the owner's again" : rest[0]}.` : "No such tenant.");
    process.exit(rec ? 0 : 1);
  } catch (e) {
    say((e as Error).message);
    process.exit(1);
  }
} else if (cmd === "set-admin" && arg) {
  // Until every person has her own file root, the admin chat is the instance's own files: they stay the owner's. Moving the role to a friend would
  // hand them to her, so for now it can only be set (back) on the owner's record.
  if (arg !== "owner") {
    say("Not yet: the admin chat is the owner's own files, so the role can only be (re)set on 'owner' until every person has her own file root.");
    process.exit(1);
  }
  const rec = setAdmin(arg);
  say(rec ? `${rec.id} is the admin.` : "No such record.");
  process.exit(rec ? 0 : 1);
} else {
  say(usage);
  process.exit(1);
}
