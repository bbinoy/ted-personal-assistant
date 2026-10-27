import { isPlainWebAddress } from "../policy/webaddress.ts";
import { rowsOf, type ToolModule } from "./types.ts";

// The assistant's own tools: web search and page fetch, skills, the notes' file tools. Nothing to connect: they are the SDK's.
// The rows are also the ONE list of which built-in tools a run is handed (agentrun.ts builtinTools): the rows its tool set holds (the order here is the order the tool list has).
const builtin = rowsOf("", "builtin", "chat");
export const builtinModule: ToolModule = {
  name: "builtin",
  connection: { kind: "builtin" },
  rows: [
    ...builtin("skill", "Skill"), // which skills load is limited by the SDK's skills allowlist (agent.ts, skills.ts); a group or tenant has the tool only with a shared skill to load
    // The file tools are for attended runs: the owner's chat and, inside their own notes folder, a group's or a friend's; WHICH path is code (policy.ts classify). An unattended run reads
    // its notes with the notes tools instead (modules/memory/module.ts): it reads untrusted mail and has no way to change them but the logged, inferred write_note.
    ...builtin("note-file", "Read Write Edit", { attended: true }),
    // A search query is a small channel out, accepted: every run has the tool.
    ...builtin("web-search", "WebSearch"),
    ...builtin("web-fetch", "WebFetch"), // judged; the plain-address veto is below. Only the owner's runs, attended or not (ownerOnly: an address can carry data out of a conversation that holds no private data of the owner's)
  ],
  free: ["web-search", "skill", "note-file"],
  ownerOnly: ["web-fetch"],
  titles: { WebFetch: { icon: "🌐", title: "Open a web page", labels: { url: "Address", prompt: "To find out" } } },
  untrusted: ["web-fetch", "web-search"], // a page and a search result are written by third parties
  floor: { judgeVeto: { "web-fetch": (input) => isPlainWebAddress(input.url) } }, // opening a page is judged only for a plain public https address: an address can carry data out
};
