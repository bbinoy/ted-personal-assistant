import { rowsOf, type ToolModule } from "../types.ts";

// people (peopletool.ts): find_person, the address book of the conversation: its people notes and, for a friend, her own Google Contacts. Read-only and scoped to ONE conversation by its
// server (the notes folder and her session are closed over), so a group has its own notes only and nobody sees another's contacts. Free like every read; what it returns is third-party
// text, so the run counts as having read untrusted data (the default for a read). An address it finds changes nothing about sending: approvals and the recipient floor are central.
const people = rowsOf("mcp__people__", "people", "chat");
export const peopleModule: ToolModule = {
  name: "people",
  connection: { kind: "in-process", name: "people", when: (ctx) => !!ctx.memory && !ctx.browsing },
  rows: people("read", "find_person", { only: ["chat", "group"] }),
  free: ["read"],
};
