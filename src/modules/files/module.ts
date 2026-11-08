import { isPlainWebAddress } from "../../policy/webaddress.ts";
import { rowsOf, type ToolModule } from "../types.ts";

// files (filetool.ts): open_file reads a file the model names: a web address (any PDF link), a PDF it already opened (search, page ranges), and where the conversation has mail, a mail
// attachment (Mailbird's, fetched by code over its own connection). The file is kept in the turn as file1, file2... for the `send` tool (file: "file1"). Every conversation has it (the
// `chat` capability: a PDF someone sends in a group is kept the same way); the mail part of the tool exists only in a run that is offered Mailbird's get_attachment_content. What a
// file holds is written by whoever made it: its reads are untrusted, like mail.
const FILES_PREFIX = "mcp__files__";
export const OPEN_TOOL = `${FILES_PREFIX}open_file`;
export const ATTACHMENT_TOOL = "mcp__mailbird__get_attachment_content";

export const filesModule: ToolModule = {
  name: "files",
  connection: { kind: "in-process", name: "files", when: (ctx) => !!ctx.key && ctx.offers(OPEN_TOOL) },
  // One tool, two kinds of call. With a `url` it is a page fetch like WebFetch (an address can carry data out): the action is "fetch", judged from the provenance, vetoed unless the address is
  // plain and public, and its url is audited. A held file or a mail attachment is a read of something already here: `freeWhen` makes that call free. Its output is untrusted either way.
  rows: rowsOf(FILES_PREFIX, "files", "chat")("fetch", "open_file"),
  freeWhen: { fetch: (input) => !input.url },
  untrusted: ["fetch"],
  floor: { judgeVeto: { fetch: (input) => isPlainWebAddress(input.url) } },
  untrustedPrefix: FILES_PREFIX,
};
