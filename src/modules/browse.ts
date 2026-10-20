import { settings } from "../settings.ts";
import { rowsOf, type ToolModule } from "./types.ts";

// browse (browse.ts): the entry tool starts a sandboxed run with the browser; it is judged like everything else. What it brings back is the web, so reading it
// makes the run's arguments untrusted. The research-booking skill is its skill.
export const browseModule: ToolModule = {
  name: "browse",
  connection: {
    kind: "in-process",
    name: "browse",
    when: (ctx) => settings.browse && (ctx.source === "chat" || ctx.source === "background" || ctx.source === "group") && ctx.offers("mcp__browse__browse"),
  },
  rows: rowsOf("mcp__browse__", "browse", "browse")("browse", "browse"),
  titles: { "mcp__browse__browse": { icon: "🌐", title: "Start a browser task", labels: { task: "Task" } } },
  untrusted: true,
  skills: [{ name: "research-booking", shared: ["browse"] }],
};

// The browser server's tools (@playwright/mcp, a separate process), in the browse run only (denied everywhere else). Which element a click or a field is,
// and which addresses are fine, is code (browse.ts, browseguard.ts): reads and plain clicks run, a page address and typed text go to the approval judge, a
// click that commits (book, buy, send...) is turned into an ask by code, payment and login fields are denied. Any other tool of the server is denied there.
const browser = rowsOf("mcp__browser__browser_", "browse", "browse");
export const browserModule: ToolModule = {
  name: "browser",
  connection: { kind: "external", name: "browser", forBrowse: true, when: (ctx) => ctx.browsing && !!ctx.guard },
  rows: [
    ...browser("browser-read", "snapshot find wait_for tabs hover navigate_back click press_key take_screenshot mouse_click_xy mouse_move_xy mouse_wheel", { only: ["browse"] }),
    ...browser("browser-nav", "navigate", { only: ["browse"] }),
    ...browser("browser-input", "type fill_form select_option", { only: ["browse"] }),
    ...browser("browser-dialog", "handle_dialog", { only: ["browse"] }),
  ],
  free: ["browser-read"],
  untrusted: true,
  ownerOnly: true, // the browse run alone
};
