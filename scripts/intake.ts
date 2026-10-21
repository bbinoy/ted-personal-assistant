// npm run intake                         start the intake page (127.0.0.1:INTAKE_PORT; a tunnel puts it on the internet, docs/SETUP.md "The intake page")
// (npm run intake -- link owner <purpose> is gone: the page never writes the owner's folder; npm run card / npm run profile do)
// Local terminal only. The page writes with its own write-only OpenBao token (npm run openbao -- setup makes it); it prints no value, no code and no path.
import "../src/core/log.ts"; // first, like main.ts: timestamps, redaction (a token-shaped string never reaches a file), owner-only files, and the stderr file trimmed at start
import { macKeychain } from "../src/secrets/keychain.ts";
import { LinkStore } from "../src/intake/intakelinks.ts";
import { googleProvider } from "../src/intake/googleoauth.ts";
import { notionProvider } from "../src/intake/notionoauth.ts";
import { OAuthFlows } from "../src/intake/oauth.ts";
import { IntakeServer } from "../src/intake/intakeserver.ts";
import { IntakeWriter } from "../src/intake/intakestore.ts";
import { appBao, keychainNames } from "../src/secrets/secrets.ts";
import { settings } from "../src/core/settings.ts";

const [cmd] = process.argv.slice(2);
const say = (l: string) => console.log(l);
const cfg = settings.intake;

if (cmd === "link") {
  // The page faces the internet, so its OpenBao token is denied the owner's folder (openbaoadmin.ts intakePolicyHcl): the owner's card and details are set on this Mac, with the app's own token.
  say("The intake page does not write the owner's items. Use npm run card -- set (your card) or npm run profile -- set (a saved detail) in this terminal.");
  process.exit(1);
} else if (cmd === undefined) {
  if (!(await macKeychain.get(keychainNames(settings.openbao.keychainPrefix).intake))) {
    say("There is no intake token in this Mac's Keychain: run npm run openbao -- setup (it makes the page's write-only token).");
    process.exit(1);
  }
  const page = new IntakeServer({ links: new LinkStore(), writer: new IntakeWriter(appBao({ as: "intake" })), oauth: new OAuthFlows({ providers: [googleProvider(), notionProvider()] }) });
  page.server.listen(cfg.port, "127.0.0.1", () => say(`intake: listening on 127.0.0.1:${cfg.port}; links ${cfg.baseUrl ? `point to ${cfg.baseUrl}` : "are not offered to friends (INTAKE_BASE_URL is not set)"}`));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => page.server.close(() => process.exit(0)));
} else {
  say("usage: npm run intake");
  process.exit(1);
}
