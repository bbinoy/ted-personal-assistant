import { instanceDb } from "../src/core/instancedb.ts";
import { owner } from "../src/conversation/conversationmodel.ts";
import { heldPosts, resetHeld } from "../src/heartbeat/notices.ts";

// What the owner's next run will be told as facts (core/ownerfact.ts): the system matters held for her, live. Import it AFTER the test has set HARNESS_DATA_DIR.
export const ownerFacts = (): string[] => new Proxy([] as string[], { get: (_t, k) => Reflect.get(heldPosts(owner()).map((h) => h.text), k) });
// A clean start: no fact waiting and no notice marked as told (so every matter may be raised again).
export function resetOwnerFacts(): void {
  instanceDb().run("DELETE FROM told");
  resetHeld(owner());
}
