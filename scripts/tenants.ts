// npm run tenants -- list | pending | invite <+number|username> | approve <id> | decline <id> | forget <id> | remove <id> | timezone <id> <zone|default> | set-admin <id>: the administrator's terminal side of tenants
// (docs/SETUP.md "More than one person"). Local terminal only. This is the ONLY place the admin role changes: no tool, no chat path,
// no model can reach it (a friend's capabilities are not stored: every capability but the owner's own, tenants.ts OWNER_ONLY; to stop a friend, suspend or remove her). test/tenants.test.ts walks every tool.
import { settings, signalIdentity } from "../src/core/settings.ts";
import { loadMessengerInUse } from "../src/conversation/messenger.ts";
import { approve, decline, describePending, forget, invitePerson } from "../src/tenants/registration.ts";
import { describeTenants } from "../src/tenants/tenanttools.ts";
import { ensureOwner, setAdmin, setTimeZone } from "../src/tenants/tenants.ts";
import { removeFriend } from "../src/conversation/tenantremoval.ts";
import { appBao, deleteTenantItems } from "../src/secrets/secrets.ts";
import { Admin, layoutOf } from "../src/secrets/openbaoadmin.ts";
import { macKeychain } from "../src/secrets/keychain.ts";

const [cmd, arg, ...rest] = process.argv.slice(2);
const say = (l: string) => console.log(l);
const usage = `usage: npm run tenants -- list | pending | invite <+number|username> | approve <id> | decline <id> | forget <id> | remove <id> | timezone <id> <zone|default> | set-admin <id>`;

// The admin role is the way back in after a lock-out, so it works with TENANTS off too; everything about friends needs TENANTS=on.
if (cmd !== "set-admin" && !settings.tenants) {
  say("TENANTS is off. Set TENANTS=on in .env (and give the assistant its own Signal account) first; see docs/SETUP.md.");
  process.exit(1);
}
ensureOwner({ number: signalIdentity().ownerNumber, aci: signalIdentity().ownerAci });

if (cmd === "list") {
  const lines = describeTenants();
  say(lines.join("\n"));
  if (lines.length === 1) say("No tenants yet. Anyone can write to the assistant; you are asked in your chat whether to let them in (npm run tenants -- pending).");
} else if (cmd === "pending") {
  // Strangers who wrote to the assistant: open requests and declined senders (their names are sanitised; what they wrote is not shown).
  const lines = describePending();
  say(lines.length ? lines.join("\n") : "Nobody is waiting.");
} else if (cmd === "invite" && arg) {
  // You write first: ONE fixed hello (never model-written) to a number or a Signal username. When she answers she is a friend with no question. Uses the running
  // agent's signal-cli daemon, like `npm run signal:hello`.
  const id = signalIdentity();
  if (id.account === id.ownerNumber) {
    say("SIGNAL_ACCOUNT is not set: the assistant talks in Note to Self, so it cannot write to anybody else (docs/SIGNAL-ACCOUNT.md).");
    process.exit(1);
  }
  const messenger = await loadMessengerInUse({ owner: { address: id.ownerNumber, id: id.ownerAci }, account: id.account });
  try {
    if (!messenger.sendFirst) throw new Error(`${messenger.name} cannot write first to a person`);
    await messenger.start();
    const { preapproved } = await invitePerson(arg, (to, text) => messenger.sendFirst!(to, text));
    say(preapproved ? "Hello sent. When she answers she is a friend, no further question." : "Hello sent, but her account could not be recognised: if she answers you are asked as for anyone else.");
  } catch (e) {
    say(`Not sent: ${(e as Error).message}`);
    messenger.stop();
    process.exit(1);
  }
  messenger.stop();
  process.exit(0);
} else if ((cmd === "approve" || cmd === "decline" || cmd === "forget") && arg) {
  // The same decision as a yes or no in your chat, from the terminal. Approving here does not message her: the assistant answers her next message (the text she
  // wrote while she waited is dropped). `forget` lets a declined sender ask again.
  if (cmd === "approve") {
    const done = approve(arg);
    say(done ? `${done.tenant.id} (${done.tenant.name}) is a friend now.` : "No open or declined request with that id (npm run tenants -- pending), or it is not unique.");
    process.exit(done ? 0 : 1);
  }
  const ok = cmd === "decline" ? decline(arg) : forget(arg);
  say(ok ? `${cmd}: done.` : "No such request.");
  process.exit(ok ? 0 : 1);
} else if (cmd === "remove" && arg) {
  // A friend and ALL her data: folder, cloned voices, voice-note index and audio, intake marks and her items in the secret store. The app's token may not delete another
  // person's folder in OpenBao, so this tries it with the admin's own (a short-lived root token from the Keychain shares) when the app's is refused; if neither works the
  // exact command is printed. Safe to run again.
  const cfg = settings.openbao;
  const admin = new Admin({ layout: layoutOf(cfg.dir), addr: cfg.addr, mount: cfg.mount, role: cfg.role, tenant: "owner", prefix: cfg.keychainPrefix, keychain: macKeychain });
  const r = await removeFriend(arg, { secrets: [(t) => deleteTenantItems(appBao(), t), (t) => admin.forgetTenant(t)] });
  if (!r) {
    say("Not a friend's id.");
    process.exit(1);
  }
  say(r.removed.length || r.registry ? `${arg}: removed${r.registry ? " (registry entry and folder)" : ""}${r.removed.length ? `, ${r.removed.join(", ")}` : ""}.` : `${arg}: nothing left to remove.`);
  if (r.failed.length) say(`Not removed (run it again): ${r.failed.join(", ")}.`);
  if (r.manual) say(r.manual);
  process.exit(r.failed.length || r.manual ? 1 : 0);
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
