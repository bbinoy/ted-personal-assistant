import { rowsOf, type ModuleFloor, type ToolModule } from "./types.ts";

// Notion, through the owner's claude.ai connector. The model sees only the tools in `hide.visible` below (NOTION_TOOLS replaces them): every tool schema is re-sent on every model call
// and Notion alone was ~58k tokens of a ~118k floor. A friend's own Notion is another module (notionhosted.ts: the hosted Notion MCP with her token).
const NOTION = "mcp__claude_ai_Notion__";

// WHAT the tools are, by action (the hosted server's names are the connector's): shared by this module and by a friend's own Notion (modules/notionhosted.ts), which
// serves the same tools under another prefix and adds nothing to what they are.
export const NOTION_TOOLS_BY_ACTION: readonly (readonly [action: string, names: string])[] = [
  ["read", "notion-fetch notion-search"],
  ["page-write", "notion-create-pages notion-update-page"],
  ["comment-write", "notion-create-comment"],
  ["page-move", "notion-move-pages"],
];
// The owner's connector has more reads than a friend is offered. Beyond the default visible list (`hide.visible`) they are hidden from the model, but are listed so that
// enabling one in the settings makes it a free, untrusted read and not a tool nobody knows. (The rest of the connector, sessions and databases, asks.)
const OWNER_READS = "notion-ai-search notion-get-comments notion-get-users notion-get-teams notion-get-tool-access notion-list-recent-pages notion-list-favorite-pages notion-list-private-pages notion-list-shared-pages notion-query-data-sources notion-query-meeting-notes notion-query-multiple-data-sources notion-search-agents";
export const notionRows = (prefix: string, o: Parameters<ReturnType<typeof rowsOf>>[2] = {}) => NOTION_TOOLS_BY_ACTION.flatMap(([action, names]) => rowsOf(prefix, "notion", "notion")(action, names, o));

// The floor of Notion's tools, shared by the owner's connector and a friend's own Notion (modules/notionhosted.ts spreads it): moving a page is always the
// person's call (never judged). A page sent to the bin (notion-update-page with in_trash or archived true) is a destructive action the judge handles with care (neverallowed.ts
// ConfirmDelete): never free, never fixed. The same flags on any other tool, and allow_deleting_content (it deletes child pages), stay never allowed.
export const NOTION_FLOOR: ModuleFloor = { judgeNever: ["page-move"], confirmDelete: { tools: ["notion-update-page"], flags: ["in_trash", "archived"] }, creates: (name) => name === "notion-create-pages" };
export const NOTION_UPDATE_TITLE = { icon: "📝", title: "Change Notion page", whenDeleting: "Move Notion page to the bin", labels: { page_id: "Page", in_trash: "In the bin", archived: "Archived" } } as const;

export const notionModule: ToolModule = {
  name: "notion",
  connection: { kind: "connector", key: "notion", label: "Notion", skipped: "meeting prep pages", server: /\bnotion\b/i, prefix: NOTION },
  rows: [...notionRows(NOTION), ...rowsOf(NOTION, "notion", "notion")("read", OWNER_READS)],
  free: ["read"],
  titles: { [`${NOTION}notion-update-page`]: NOTION_UPDATE_TITLE },
  floor: NOTION_FLOOR,
  skills: [{ name: "notion-tasks", required: true }],
  setup: [
    { file: "setup-meetings.md", label: "meeting notes (where prep pages go)", needs: "notion" },
  ],
  hide: {
    prefix: NOTION,
    visible: ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page"],
    valid: /^notion-[\w-]+$/,
    hint: "a Notion tool name like notion-fetch",
  },
  known: "ai-search check-mcp-next-steps convert-page-to-skill create-attachment create-comment create-database create-file-upload create-folder create-view download-attachment download-skill duplicate-page get-async-task get-comments get-session-status get-teams get-tool-access get-users list-favorite-pages list-private-pages list-recent-pages list-session-events list-shared-pages move-pages query-data-sources query-meeting-notes query-multiple-data-sources query-sessions read-session-event search-agents search-sessions send-message-to-session show-advanced-analysis-next-steps spawn-session stop-session update-data-source update-folder update-view upload-skill wait-session"
    .split(" ")
    .map((t) => `${NOTION}notion-${t}`),
};
