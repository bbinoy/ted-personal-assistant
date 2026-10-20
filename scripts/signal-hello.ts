// `npm run signal:hello`: the assistant's own Signal account sends you a first message, so the chat
// exists on your phone (an account without a phone number cannot be found by number). Run it
// while the agent is running with SIGNAL_ACCOUNT set; it uses the agent's own signal-cli daemon.
import { loadMessengerInUse } from "../src/messenger.ts";
import { settings, signalIdentity } from "../src/settings.ts";

const identity = signalIdentity();
if (identity.account === identity.ownerNumber) {
  console.error("SIGNAL_ACCOUNT is not set: the assistant talks in Note to Self, so there is nothing to start. See docs/SIGNAL-ACCOUNT.md.");
  process.exit(1);
}
const messenger = await loadMessengerInUse({ owner: { address: identity.ownerNumber, id: identity.ownerAci }, account: identity.account });
await messenger.start();
await messenger.send(undefined, { text: `Hi, it's ${settings.assistant}. This is my own chat now, so you can talk to me here. Say hi back and I'll answer. 👋` });
messenger.stop();
console.log("sent: look for a message request from the assistant on your phone, accept it and say hi");
process.exit(0);
