// npm run card -- set|list|enable|disable|delete|payments|clear: the owner's payment card for the browse worker (src/modules/browse/cardcli.ts). Local terminal only.
import { CardStore, killSwitch } from "../src/modules/browse/card.ts";
import { cardCli } from "../src/modules/browse/cardcli.ts";
import { Ledger } from "../src/modules/browse/payments.ts";
import { readHiddenFromTerminal } from "../src/modules/browse/profilecli.ts";

try {
  process.exit(await cardCli(process.argv.slice(2), { store: new CardStore(), kill: killSwitch, ledger: new Ledger(), readHidden: readHiddenFromTerminal, out: (l) => console.log(l) }));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
