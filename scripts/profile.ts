// npm run profile -- set|list|domains|delete: the owner's saved details for the browse worker (src/modules/browse/profilecli.ts). Local terminal only.
import { ProfileStore } from "../src/modules/browse/profile.ts";
import { profileCli, readHiddenFromTerminal } from "../src/modules/browse/profilecli.ts";

try {
  process.exit(await profileCli(process.argv.slice(2), { store: new ProfileStore(), readHidden: readHiddenFromTerminal, out: (l) => console.log(l) }));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
