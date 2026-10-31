import { settings } from "../../core/settings.ts";
import { rowsOf, type ToolModule } from "../types.ts";

// files (filetool.ts): open_file reads a mail attachment (Mailbird's, fetched by code over its own connection) so the model sees the document itself, and keeps it in the
// turn as file1, file2... for the `send` tool (file: "file1"). The owner's conversations only (the `login` capability: it is her Mailbird); offered only where the mail skill
// that teaches it is. What a file holds is written by whoever sent the mail: its reads are untrusted, like mail.
const FILES_PREFIX = "mcp__files__";
export const OPEN_TOOL = `${FILES_PREFIX}open_file`;

export const filesModule: ToolModule = {
  name: "files",
  connection: { kind: "in-process", name: "files", when: (ctx) => !!ctx.key && settings.mailProvider === "mailbird" && ctx.offers(OPEN_TOOL) },
  rows: rowsOf(FILES_PREFIX, "files", "login")("read", "open_file"),
  free: ["read"],
  untrustedPrefix: FILES_PREFIX,
};
