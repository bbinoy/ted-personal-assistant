import { NOTION_FLOOR, notionRows } from "./notion.ts";
import { type Connection, type RunContext, type ToolModule } from "./types.ts";

// Notion for friends (capability `notion`): a friend's OWN Notion, through Notion's hosted MCP server and her own OAuth grant (src/notionoauth.ts, src/notionmcp.ts). The
// owner never has these tools (his Notion is the connector, modules/notion.ts); a friend never has the owner's. The tools are the same ones with the same actions as the
// owner's (notionRows is shared, not copied); the server calls them under the name `notion`, so a friend's are mcp__notion__notion-search and so on.
//
// How a call is treated is not written here: the rows say what a tool is (read, page-write, comment-write, page-move), a read runs free and is shown to the judge as outside text,
// everything else goes to the central floor, the unified judge and HER chat. The floor is the owner's (notion.ts NOTION_FLOOR): moving a page is always her call, and a page to the bin is never allowed.
export const NOTION_FRIEND_PREFIX = "mcp__notion__";

const only = { only: ["group"] } as const; // a friend's run is an isolated "group" run; the owner's policy source has no such tool

// The tools a friend's run is shown for her Notion (the hosted server has many more: sessions, databases, views, ...; they are not offered).
export const NOTION_FRIEND_TOOLS: readonly string[] = notionRows(NOTION_FRIEND_PREFIX, only).map((e) => e.tool);
// Any of her tools would start her connection; this one is in every set that has the capability.
export const NOTION_PROBE = `${NOTION_FRIEND_PREFIX}notion-search`;

const connection = (when: (ctx: RunContext) => boolean): Connection => ({ kind: "external", name: "notion", when });

export const notionHostedModule: ToolModule = {
  name: "notionhosted",
  // Nobody has her connection by default; a friend's run does when her capability set has its tools (connectionFor). The owner's run never does.
  connection: connection(() => false),
  connectionFor: (ctx) => (ctx.tenant && !ctx.browsing ? connection((c) => !!c.tenant && c.offers(NOTION_PROBE)) : undefined),
  rows: notionRows(NOTION_FRIEND_PREFIX, only),
  free: ["read"],
  untrustedPrefix: NOTION_FRIEND_PREFIX,
  titles: {
    [`${NOTION_FRIEND_PREFIX}notion-create-pages`]: { icon: "📝", title: "Create Notion page" },
    [`${NOTION_FRIEND_PREFIX}notion-update-page`]: { icon: "📝", title: "Change Notion page" },
    [`${NOTION_FRIEND_PREFIX}notion-create-comment`]: { icon: "💬", title: "Comment in Notion" },
    [`${NOTION_FRIEND_PREFIX}notion-move-pages`]: { icon: "📂", title: "Move Notion pages" },
  },
  floor: NOTION_FLOOR,
};
