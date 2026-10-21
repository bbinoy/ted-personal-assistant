import { pendingFileOf } from "../approvals/pending.ts";
import { forgetConversation } from "../modules/voice/voicenote.ts";
import { removeTenant, type RemovalDeps } from "../tenants/removal.ts";

// Removing a friend with everything the layers above the tenants hold of her (her voice-note index, her pending approvals): tenants/removal.ts has the steps,
// this wires the two it may not import. heartbeat/wiring.ts hands it to the owner's remove_tenant tool, scripts/tenants.ts (remove) calls it.
export const removeFriend = (id: string, d: RemovalDeps = {}) => removeTenant(id, { forgetNotes: forgetConversation, pendingFile: pendingFileOf, ...d });
