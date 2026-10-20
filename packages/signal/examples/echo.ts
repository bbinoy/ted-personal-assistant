// Note to Self echo: the bot is a linked device of YOUR Signal account and repeats what you write to yourself.
//   SIGNAL_NUMBER=+10000000000 node examples/echo.ts
// (signal-cli must be installed and the number registered or linked; see docs/signal-account.md)
import { SignalClient, ensureSignalDaemon } from "@ted-assistant/signal";

const me = process.env.SIGNAL_NUMBER;
if (!me) throw new Error("set SIGNAL_NUMBER to your own number, like +10000000000");

const host = "127.0.0.1";
const port = 7583;
const daemon = await ensureSignalDaemon({ account: me, host, port, logger: console });
const signal = new SignalClient({ host, port, account: me, logger: console });

// The library never exits your process. Here: if Signal goes away, stop; a supervisor (systemd, launchd, ...) can restart us.
signal.onClose(() => process.exit(1));
void daemon.exited.then(() => process.exit(1));
process.once("SIGINT", () => (signal.close(), daemon.stop(), process.exit(0)));

signal.onMessage((m) => {
  // `direct` in Note to Self means: you wrote it to yourself. Our own reply comes back the same way, so skip it.
  if (!m.direct || m.text.startsWith("you said: ")) return;
  void signal.send(`you said: ${m.text}`, { quote: { text: m.text, author: m.from, timestamp: m.timestamp } });
});

await signal.connect();
console.log("echo is running: write something to your Note to Self");
