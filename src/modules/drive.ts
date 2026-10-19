import { rowsOf, type ToolModule } from "./types.ts";

// Google Drive and Google Docs, the owner's claude.ai connectors. Hidden from the model by default (HIDDEN_CONNECTORS); the rows say what they are for the
// day they are switched on. Sharing a file hands it to other people: it is never judged and always asks.
const DRIVE = "mcp__claude_ai_Google_Drive__";
const DOCS = "mcp__claude_ai_Google_Docs__";

const drive = rowsOf(DRIVE, "drive", "google");
export const driveModule: ToolModule = {
  name: "drive",
  connection: { kind: "connector", server: /google drive/i, prefix: DRIVE },
  rows: [
    ...drive("read", "search_files read_file_content download_file_content get_file_metadata get_file_permissions list_recent_files"),
    ...drive("drive-write", "create_file update_file copy_file"),
    ...drive("share", "share_file"),
  ],
  free: ["read"],
  titles: { [`${DRIVE}share_file`]: { icon: "🔗", title: "Share a Drive file" } },
  floor: { judgeNever: ["share"], noFix: ["share"] },
};

const docs = rowsOf(DOCS, "docs", "google");
export const docsModule: ToolModule = {
  name: "docs",
  connection: { kind: "connector", server: /google docs/i, prefix: DOCS },
  rows: [...docs("read", "read_doc"), ...docs("doc-write", "update_doc")],
  free: ["read"],
};
