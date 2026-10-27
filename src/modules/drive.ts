import { rowsOf, type ToolModule } from "./types.ts";

// Google Drive and Google Docs (capability `drive`, the owner's claude.ai connectors; a friend's own Google is a separate capability, modules/google.ts), and the
// Claude Docs connector. Google Drive and Google Docs are visible to the owner's chat by default (HIDDEN_CONNECTORS hides them again; Claude Docs stays hidden by default). Their reads are free
// and untrusted (a file's text is written by whoever can edit it). Sharing a file hands it to other people: it is never judged and always asks. Moving a file to the bin is never allowed (neverallowed.ts NEVER_ACTIONS, like Gmail trash); Claude Docs
// delete is never allowed, like everywhere (neverallowed.ts).
const DRIVE = "mcp__claude_ai_Google_Drive__";
const DOCS = "mcp__claude_ai_Google_Docs__";
const CLAUDE_DOCS = "mcp__claude_ai_Claude_Docs__";

const drive = rowsOf(DRIVE, "drive", "drive");
export const driveModule: ToolModule = {
  name: "drive",
  connection: { kind: "connector", optional: true, key: "drive", label: "Google Drive", skipped: "reading and saving Drive files", server: /google drive/i, prefix: DRIVE },
  rows: [
    ...drive("read", "search_files read_file_content download_file_content get_file_metadata get_file_permissions list_recent_files"),
    ...drive("drive-write", "create_file update_file copy_file"),
    ...drive("share", "share_file"),
    ...drive("trash", "trash_file"), // to the bin: never allowed, like Gmail trash (neverallowed.ts NEVER_ACTIONS)
  ],
  free: ["read"],
  titles: { [`${DRIVE}share_file`]: { icon: "🔗", title: "Share a Drive file" }},
  floor: { judgeNever: ["share"] },
  // The model reads and finds files; saving, copying and sharing go through other paths, and each of those definitions costs context on every call (DRIVE_TOOLS replaces the list).
  hide: { prefix: DRIVE, visible: ["search_files", "read_file_content", "list_recent_files", "get_file_metadata"], valid: /^[a-z_]+$/, hint: "a Drive tool name like search_files" },
  known: "copy_file create_file download_file_content get_file_metadata get_file_permissions list_recent_files read_file_content search_files share_file trash_file update_file".split(" ").map((t) => `${DRIVE}${t}`),
};

const docs = rowsOf(DOCS, "docs", "drive");
export const docsModule: ToolModule = {
  name: "docs",
  connection: { kind: "connector", optional: true, key: "docs", label: "Google Docs", skipped: "reading and editing Google Docs", server: /google docs/i, prefix: DOCS },
  rows: [...docs("read", "read_doc"), ...docs("doc-write", "update_doc")],
  free: ["read"],
  hide: { prefix: DOCS, visible: ["read_doc"], valid: /^[a-z_]+$/, hint: "a Docs tool name like read_doc" }, // update_doc alone is 2.6k tokens (DOCS_TOOLS replaces the list)
  known: [`${DOCS}read_doc`, `${DOCS}update_doc`],
};

// The Claude Docs connector (living documents): reads are free, writes are judged, and its plain `delete` is never allowed.
const claudeDocs = rowsOf(CLAUDE_DOCS, "claudedocs", "drive");
export const claudeDocsModule: ToolModule = {
  name: "claudedocs",
  connection: { kind: "connector", key: "claudedocs", label: "Claude Docs", skipped: "living documents in Claude Docs", server: /claude docs/i, prefix: CLAUDE_DOCS },
  rows: [...claudeDocs("read", "read query guide export"), ...claudeDocs("doc-write", "create update batch"), ...claudeDocs("delete", "delete")],
  free: ["read"],
};
