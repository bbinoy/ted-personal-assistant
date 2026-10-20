import { notionRows } from "./notion.ts";
import { rowsOf, tenantOffered, type ToolModule } from "./types.ts";

// Notion for friends (capability `notion`): a friend's OWN Notion, through Notion's hosted MCP server and her own OAuth grant (src/notionoauth.ts, src/notionmcp.ts). The
// owner never has these tools (his Notion is the connector, modules/notion.ts); a friend never has the owner's. The tools are the same ones with the same actions as the
// owner's (notionRows is shared, not copied); the server calls them under the name `notion`, so a friend's are mcp__notion__notion-search and so on.
//
// How a call is treated is not written here: the rows say what a tool is (read, page-write, comment-write), a read runs free and is shown to the judge as outside text,
// everything else goes to the central floor, the unified judge and HER chat. What this module adds is only what a row cannot say: moving a page is always her call.
export const NOTION_FRIEND_PREFIX = "mcp__notion__";

const only = { only: ["group"] } as const; // a friend's run is an isolated "group" run; the owner's policy source has no such tool
const notion = rowsOf(NOTION_FRIEND_PREFIX, "notion", "notion");

// The tools a friend's run is shown for her Notion (the hosted server has many more: sessions, databases, views, ...; they are not offered).
const rows = [...notionRows(NOTION_FRIEND_PREFIX, only), ...notion("page-move", "notion-move-pages", only)];
export const NOTION_FRIEND_TOOLS: readonly string[] = rows.map((e) => e.tool);

// A page sent to the bin is a destructive change however the tool names it: never judged, always asked.
const TRASHES = /"(?:in_trash|archived|trash)"\s*:\s*(?:true|"true")/i;

export const notionHostedModule: ToolModule = {
  name: "notionhosted",
  // Her connection exists for a friend's run whose capability set offers any of its tools; the owner's run never has it (his Notion is the connector), nor does a group's.
  connection: { kind: "external", name: "notion", when: tenantOffered(rows) },
  rows,
  personal: true,
  free: ["read"],
  untrusted: ["read"], // page and comment text is written by whoever can edit the page
  untrustedPrefix: NOTION_FRIEND_PREFIX,
  titles: {
    [`${NOTION_FRIEND_PREFIX}notion-create-pages`]: { icon: "📝", title: "Create Notion page" },
    [`${NOTION_FRIEND_PREFIX}notion-update-page`]: { icon: "📝", title: "Change Notion page" },
    [`${NOTION_FRIEND_PREFIX}notion-create-comment`]: { icon: "💬", title: "Comment in Notion" },
    [`${NOTION_FRIEND_PREFIX}notion-move-pages`]: { icon: "📂", title: "Move Notion pages" },
  },
  floor: {
    judgeNever: ["page-move"],
    judgeVeto: { "page-write": (input) => !TRASHES.test(JSON.stringify(input)) },
    noFix: ["page-move"],
  },
};
