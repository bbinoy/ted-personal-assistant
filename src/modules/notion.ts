import { rowsOf, type ToolModule } from "./types.ts";

// Notion, through the owner's claude.ai connector. The model sees only the tools in NOTION_TOOLS (settings): every tool schema is re-sent on every model call
// and Notion alone was ~58k tokens of a ~118k floor. A friend's own Notion is another module (notionhosted.ts: the hosted Notion MCP with her token).
const NOTION = "mcp__claude_ai_Notion__";

// WHAT the tools are, by action (the hosted server's names are the connector's): shared by this module and by a friend's own Notion (modules/notionhosted.ts), which
// serves the same tools under another prefix and adds nothing to what they are.
export const NOTION_TOOLS_BY_ACTION: readonly (readonly [action: string, names: string])[] = [
  ["read", "notion-fetch notion-search"],
  ["page-write", "notion-create-pages notion-update-page"],
  ["comment-write", "notion-create-comment"],
];
export const notionRows = (prefix: string, o: Parameters<ReturnType<typeof rowsOf>>[2] = {}) => NOTION_TOOLS_BY_ACTION.flatMap(([action, names]) => rowsOf(prefix, "notion", "notion")(action, names, o));

export const notionModule: ToolModule = {
  name: "notion",
  connection: { kind: "connector", key: "notion", server: /\bnotion\b/i, prefix: NOTION },
  rows: notionRows(NOTION),
  free: ["read"],
  skills: [{ name: "notion-tasks", required: true }],
  setup: [
    { file: "setup-tasks.md", label: "task list (your Notion page)", needs: "notion" },
    { file: "setup-meetings.md", label: "meeting notes (where prep pages go)", needs: "notion" },
  ],
  hide: { prefix: NOTION, keep: (cfg) => cfg.notionTools },
  known: "ai-search check-mcp-next-steps convert-page-to-skill create-attachment create-comment create-database create-file-upload create-folder create-view download-attachment download-skill duplicate-page get-async-task get-comments get-session-status get-teams get-tool-access get-users list-favorite-pages list-private-pages list-recent-pages list-session-events list-shared-pages move-pages query-data-sources query-meeting-notes query-multiple-data-sources query-sessions read-session-event search-agents search-sessions send-message-to-session show-advanced-analysis-next-steps spawn-session stop-session update-data-source update-folder update-view upload-skill wait-session"
    .split(" ")
    .map((t) => `${NOTION}notion-${t}`),
};
