// npm run forget -- friend <id> | group <folder name|name>: take a whole conversation out of the data folder. Local terminal only. Safe to run again.
//   friend <id>   the friend and ALL her data: registry entry, her folder (notes, history, session, cost, pending approvals, cloned voices), voice-note audio, intake marks and her items in the
//                 secret store (npm run tenants -- remove does the same). The app's token may not delete another person's folder in OpenBao, so this tries the admin's own when it is refused.
//   group <ref>   a group's folder and its keys (the day's spend, the notice marks). The folder name is group-<16 hex> (conversations/ lists them), or give the group's name.
//                 The assistant does NOT leave the group (leave it in Signal); if it writes again, a new empty folder starts.
// Stop the agent first if the conversation is still active (it would start a new folder with its next message).
import "../src/core/requirelayout.ts";
import { forgetGroup, friendSecretSteps, forgetFriend } from "../src/conversation/forget.ts";

const [kind, ref] = process.argv.slice(2);
const say = (l: string) => console.log(l);
const usage = "usage: npm run forget -- friend <id> | group <folder name|name>";

if (kind === "friend" && ref) {
  const r = await forgetFriend(ref, { secrets: friendSecretSteps() });
  if (!r) {
    say("Not a friend's id.");
    process.exit(1);
  }
  say(r.removed.length || r.registry ? `${ref}: removed${r.registry ? " (registry entry and folder)" : ""}${r.removed.length ? `, ${r.removed.join(", ")}` : ""}.` : `${ref}: nothing left to remove.`);
  if (r.failed.length) say(`Not removed (run it again): ${r.failed.join(", ")}.`);
  if (r.manual) say(r.manual);
  process.exit(r.failed.length || r.manual ? 1 : 0);
} else if (kind === "group" && ref) {
  const r = forgetGroup(ref);
  if ("error" in r) {
    say(r.error);
    process.exit(1);
  }
  say(r.removed.length ? `${r.conv}${r.name ? ` (${r.name})` : ""}: removed ${r.removed.join(", ")}.` : `${r.conv}: nothing left to remove.`);
  if (r.failed.length) say(`Not removed (run it again): ${r.failed.join(", ")}.`);
  process.exit(r.failed.length ? 1 : 0);
} else {
  say(usage);
  process.exit(1);
}
