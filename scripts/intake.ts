// npm run intake                         start the intake page (127.0.0.1:INTAKE_PORT; a tunnel puts it on the internet, docs/SETUP.md "The intake page")
// npm run intake -- link owner <purpose> a one-time link on this Mac's loopback so the owner can enter a detail or a card without the chat
// Local terminal only. The page writes with its own write-only OpenBao token (npm run openbao -- setup makes it); it prints no value, no code and no path.
import { macKeychain } from "../src/secrets/keychain.ts";
import { LinkStore } from "../src/intake/intakelinks.ts";
import { PURPOSES, purposeOf } from "../src/intake/intakepurposes.ts";
import { googleProvider } from "../src/intake/googleoauth.ts";
import { notionProvider } from "../src/intake/notionoauth.ts";
import { OAuthFlows } from "../src/intake/oauth.ts";
import { IntakeServer } from "../src/intake/intakeserver.ts";
import { IntakeWriter } from "../src/intake/intakestore.ts";
import { appBao, keychainNames, OWNER } from "../src/secrets/secrets.ts";
import { settings, signalIdentity } from "../src/core/settings.ts";
import { ensureOwner } from "../src/tenants/tenants.ts";

const [cmd, who, purpose] = process.argv.slice(2);
const say = (l: string) => console.log(l);
const cfg = settings.intake;

if (cmd === "link") {
  const wanted = purpose ? purposeOf(purpose) : undefined;
  if (who !== OWNER || !purpose || !wanted || wanted.oauth) { // (the owner's Google and Notion are the Claude connectors; the sign-in purposes are for friends)
    say(`usage: npm run intake -- link owner <purpose>   (purposes: ${Object.keys(PURPOSES).join(", ")})`);
    process.exit(1);
  }
  ensureOwner({ number: signalIdentity().ownerNumber, aci: signalIdentity().ownerAci });
  const code = new LinkStore().mint({ tenant: OWNER, purpose }, cfg.linkMinutes * 60_000);
  if (!code) {
    say("Too many setup links are open at the moment.");
    process.exit(1);
  }
  say(`http://127.0.0.1:${cfg.port}/i/${code}\nOpen it in a browser on this Mac while the page is running (npm run intake). Single use, valid ${cfg.linkMinutes} minutes.`);
} else if (cmd === undefined) {
  if (!(await macKeychain.get(keychainNames(settings.openbao.keychainPrefix).intake))) {
    say("There is no intake token in this Mac's Keychain: run npm run openbao -- setup (it makes the page's write-only token).");
    process.exit(1);
  }
  const page = new IntakeServer({ links: new LinkStore(), writer: new IntakeWriter(appBao({ as: "intake" })), oauth: new OAuthFlows({ providers: [googleProvider(), notionProvider()] }) });
  page.server.listen(cfg.port, "127.0.0.1", () => say(`intake: listening on 127.0.0.1:${cfg.port}; links ${cfg.baseUrl ? `point to ${cfg.baseUrl}` : "are not offered to friends (INTAKE_BASE_URL is not set)"}`));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => page.server.close(() => process.exit(0)));
} else {
  say("usage: npm run intake | npm run intake -- link owner <purpose>");
  process.exit(1);
}
