import { isPlainWebAddress } from "../webaddress.ts";
import { rowsOf, type ToolModule } from "./types.ts";

// The assistant's own tools: web search and page fetch, skills, the notes' file tools. Nothing to connect: they are the SDK's.
const builtin = rowsOf("", "builtin", "chat");
export const builtinModule: ToolModule = {
  name: "builtin",
  connection: { kind: "builtin" },
  rows: [
    ...builtin("web-search", "WebSearch"), // a search query is a small channel out, accepted: the model is offered the tool only in runs that have the owner behind them (agentrun.ts builtinTools)
    ...builtin("web-fetch", "WebFetch"), // judged; the plain-address veto is below
    ...builtin("skill", "Skill"), // which skills load is limited by the SDK's skills allowlist (agent.ts, skills.ts); a group or tenant has the tool only with a shared skill to load
    // The file tools are for the owner's chat and, inside their own notes folder, for groups and tenants; WHICH path is code (policy.ts classify).
    ...builtin("note-file", "Read Write Edit", { only: ["chat", "group"] }),
  ],
  free: ["web-search", "skill", "note-file"],
  titles: { WebFetch: { icon: "🌐", title: "Open a web page", labels: { url: "Address", prompt: "To find out" } } },
  untrusted: ["web-fetch", "web-search"], // a page and a search result are written by third parties
  floor: { judgeVeto: { "web-fetch": (input) => isPlainWebAddress(input.url) } }, // opening a page is judged only for a plain public https address: an address can carry data out
};
