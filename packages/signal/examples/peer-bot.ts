// A bot with its OWN Signal account that talks to one person and takes part in groups when addressed.
//   SIGNAL_ACCOUNT=+10000000001 SIGNAL_OWNER=+10000000000 node examples/peer-bot.ts
// SIGNAL_ACCOUNT is the bot's number (or account id); SIGNAL_OWNER is the one person it answers.
import { SignalClient, ensureSignalDaemon } from "@ted-assistant/signal";

const account = process.env.SIGNAL_ACCOUNT;
const owner = process.env.SIGNAL_OWNER;
if (!account || !owner) throw new Error("set SIGNAL_ACCOUNT (the bot) and SIGNAL_OWNER (you)");

const host = "127.0.0.1";
const port = 7583;
const daemon = await ensureSignalDaemon({ account, host, port, logger: console });
const signal = new SignalClient({ host, port, account, peer: { number: owner }, logger: console });
signal.onClose(() => process.exit(1));
void daemon.exited.then(() => process.exit(1));

signal.onMessage(async (m) => {
  const target = { author: m.from, timestamp: m.timestamp };
  if (m.group) {
    // In a group, answer only when addressed, and only members of a group YOU are in (authorisation is yours to do).
    if (!m.addressedToMe) return;
    const groups = await signal.groups();
    if (!groups.find((g) => g.id === m.group!.id)?.members.some((x) => x.number === owner)) return;
    await signal.markRead(m.timestamp, m.from);
    await signal.send(`${m.fromName ?? "someone"} said: ${m.text}`, { groupId: m.group.id, quote: { text: m.text, author: m.from, timestamp: m.timestamp } });
    return;
  }
  if (!m.direct || m.from !== owner) return; // anybody else who finds the bot is ignored
  await signal.markRead(m.timestamp); // the "seen" check
  await signal.react("👀", target); // a status icon; a later reaction on the same message replaces it
  await signal.typing();
  await signal.send(`you said: ${m.text}`, { style: ["0:8:BOLD"] });
  await signal.typing(true);
  await signal.react("✅", target);
});

signal.onReaction((r) => {
  if (r.isRemove || signal.isOwnReaction(r)) return; // our own status icons come back as reactions
  console.log(`${r.from} reacted ${r.emoji} to message ${r.targetTimestamp}`);
});

await signal.connect();
console.log("peer bot is running");
