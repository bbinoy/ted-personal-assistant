import type { Source } from "../core/audit.ts";
import { isPlainWebAddress } from "../policy/webaddress.ts";
import { rowsOf, type ToolModule } from "./types.ts";

// The assistant's own tools: web search and page fetch, skills, the notes' file tools. Nothing to connect: they are the SDK's.
// The rows are also the ONE list of which built-in tools a run is handed (agentrun.ts builtinTools): `offeredTo` names the sources of an owner run that get the
// tool (the order here is the order the tool list has), and an isolated run (a group, a tenant) gets the rows its capability set holds.
const builtin = rowsOf("", "builtin", "chat");
const OWNER_RUNS: readonly Source[] = ["chat", "handler", "heartbeat", "radar", "dream", "background"]; // (the browse run has the browser, a group or tenant its capability set)
export const builtinModule: ToolModule = {
  name: "builtin",
  connection: { kind: "builtin" },
  rows: [
    ...builtin("skill", "Skill", { offeredTo: OWNER_RUNS }), // which skills load is limited by the SDK's skills allowlist (agent.ts, skills.ts); a group or tenant has the tool only with a shared skill to load
    // The file tools are for the owner's chat and, inside their own notes folder, for groups and tenants; WHICH path is code (policy.ts classify).
    ...builtin("note-file", "Read Write Edit", { only: ["chat", "group"], offeredTo: ["chat"] }),
    // A search query is a small channel out, accepted: the owner's chat and its background runs have the tool, and so does the browse run (a group or tenant by capability).
    ...builtin("web-search", "WebSearch", { offeredTo: ["chat", "background", "browse"] }),
    ...builtin("web-fetch", "WebFetch", { offeredTo: ["chat", "background"] }), // judged; the plain-address veto is below. Never in a group's or a tenant's set (ownerOnly)
  ],
  free: ["web-search", "skill", "note-file"],
  ownerOnly: ["web-fetch"],
  titles: { WebFetch: { icon: "🌐", title: "Open a web page", labels: { url: "Address", prompt: "To find out" } } },
  untrusted: ["web-fetch", "web-search"], // a page and a search result are written by third parties
  floor: { judgeVeto: { "web-fetch": (input) => isPlainWebAddress(input.url) } }, // opening a page is judged only for a plain public https address: an address can carry data out
};
