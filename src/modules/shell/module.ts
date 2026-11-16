import { settings } from "../../core/settings.ts";
import { rowsOf, type ToolModule } from "../types.ts";

// shell (shelltool.ts, box.ts): the workbench, a sandboxed shell. One tool, `run`: a command in a throwaway Linux VM with no network, nothing mounted, files in and out only through code. Only the
// workbench skill's expert calls it (delegation.ts refuses any other caller); every run may hand work to that expert. It reaches nothing outside the box, so it is free (never judged) and not an
// action for the journal; what it prints is text from the files it read, so it counts as untrusted (a later send or fetch is judged with that taint).
const SHELL_PREFIX = "mcp__shell__";
export const SHELL_TOOL = `${SHELL_PREFIX}run`;

export const shellModule: ToolModule = {
  name: "shell",
  connection: { kind: "in-process", name: "shell", when: (ctx) => !!ctx.key && settings.workbench && ctx.offers(SHELL_TOOL) },
  rows: rowsOf(SHELL_PREFIX, "shell", "shell")("run", "run"),
  free: true,
  untrusted: ["run"],
  skills: [{ name: "workbench", shared: ["shell"], when: () => settings.workbench }],
};
