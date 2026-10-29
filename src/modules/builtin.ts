import { isPlainWebAddress } from "../policy/webaddress.ts";
import { rowsOf, type ToolModule } from "./types.ts";

// The assistant's own tools: web search and page fetch, skills, the notes' file tools. Nothing to connect: they are the SDK's.
// The rows are also the ONE list of which built-in tools a run is handed (agentrun.ts builtinTools): the rows its tool set holds (the order here is the order the tool list has).
// ToolSearch is deliberately not offered, so every tool loads upfront (no tool is missing because the model did not search for it).
const builtin = rowsOf("", "builtin", "chat");
export const builtinModule: ToolModule = {
  name: "builtin",
  connection: { kind: "builtin" },
  skills: [{ name: "web-research", shared: ["chat"] }], // every conversation that has WebSearch (the web-search row's capability)
  rows: [
    ...builtin("skill", "Skill"), // which skills load is limited by the SDK's skills allowlist (agent.ts, skills.ts); a group or tenant has the tool only with a shared skill to load
    // The file tools are every run's way into its notes (the SDK's auto-memory): the owner's anywhere in her notes (and, to read, her data folders), an isolated conversation's inside its own notes folder only;
    // WHICH path is code (policy.ts classify). A look has them as a chat turn does: what a run that read mail may do is the judge's and the floor's, not a second, narrower tool.
    ...builtin("note-file", "Read Write Edit"),
    // A search query is a small channel out, accepted: every run has the tool.
    ...builtin("web-search", "WebSearch"),
    ...builtin("web-fetch", "WebFetch"), // judged; the plain-address veto is below. For every conversation, like WebSearch
  ],
  free: ["web-search", "skill", "note-file"],
  titles: { WebFetch: { icon: "🌐", title: "Open a web page", labels: { url: "Address", prompt: "To find out" } } },
  untrusted: ["web-fetch", "web-search"], // a page and a search result are written by third parties
  floor: { judgeVeto: { "web-fetch": (input) => isPlainWebAddress(input.url) } }, // opening a page is judged only for a plain public https address: an address can carry data out
};
