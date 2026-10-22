// npm run convdb -- list | accept <convId>: conversation databases (assistant.db) that the agent found damaged and set aside (core/convdb.ts).
//   list            the conversations that are marked damaged, with what was kept and what could not be restored
//   accept <convId> a person has looked (restored the set-aside file with the agent stopped, or chose the fresh start): the marker goes, the set-aside file is renamed assistant.db.reviewed-*, background work may run again.
//                   After a fresh start the first look skips every mail in the inbox instead of triaging it again.
// Opens no database (this process never applies the damage policy: only the running agent does).
import "../src/core/requirelayout.ts";
import { clearDamage, damagedConvs } from "../src/core/convdb.ts";
import { isConvId } from "../src/core/convpaths.ts";

const [cmd, conv] = process.argv.slice(2);
if (cmd === "list") {
  const all = damagedConvs();
  if (all.length === 0) console.log("No conversation database is marked damaged.");
  for (const d of all) console.log(`${d.conv}: set aside as ${d.keptAs || "(unknown)"}${d.at ? ` at ${d.at}` : ""}${d.pendingLost?.length ? `; approvals not restored: ${d.pendingLost.map((p) => `#${p.n} ${p.label}`).join("; ")}` : ""}`);
} else if (cmd === "accept" && conv && isConvId(conv)) {
  clearDamage(conv);
  console.log(`${conv}: accepted. Its background work runs again (stop the agent first if you restore the set-aside file over assistant.db).`);
} else {
  console.log("usage: npm run convdb -- list | accept <convId>");
  process.exit(1);
}
