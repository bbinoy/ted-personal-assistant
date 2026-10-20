// THE never-allowed set, as pure predicates on a tool's name and arguments (no imports: modules, the manifest, policy and the Gmail rules all read it).
// Trading, trash, permanent delete, spam, blocking a sender: denied for everyone (owner, group, friend) and every provider, whatever the judge or anyone says.
// Three layers, one verdict (toolmanifest.ts neverAllowedTool, policy.ts isNeverAllowed):
//   1. the manifest: a row whose action is in NEVER_ACTIONS, or a module marked `never` (the trading connector);
//   2. the name, for a tool no module lists: a token-boundary match of NEVER_NAME on the tool's own name;
//   3. the arguments, for a tool that only does it through an argument: destinationIsTrashOrSpam, neverActionValue.

export const NEVER_ACTIONS: ReadonlySet<string> = new Set(["trash", "delete", "spam", "block", "trade"]);

// Destructive but allowed, with care: deleting a draft, a calendar event, a Notion page or a Drive file to the bin. NOT in NEVER_ACTIONS. The call is never free and never
// fixed, goes to the judge (whose default for a delete is ask, told by code whether the assistant made the thing here: created.ts) and otherwise asks on the phone of the
// conversation that made it; a module's floor may veto judging it (a calendar delete that names guests). A tool that only does it through an argument (Notion's
// in_trash, a friend's manage_event with action delete) is declared by its module's floor (`confirmDelete`, ConfirmDelete below), for its own tools only.
export const DELETE_CONFIRM = "delete-confirm";

// What a module's floor says about the arguments of its tools that delete but may be confirmed: the tools (by the name after the server's), the boolean flags
// (as a tool spells them) and the values of an `action` argument that the call may use for it. Everything else the never-allowed arguments name stays denied.
export interface ConfirmDelete {
  tools: readonly string[];
  flags?: readonly string[];
  actions?: readonly string[];
}

export const NEVER_NAME = /(^|[_-])(trash|delete|purge|erase|destroy|spam|junk|block(ed)?)([_-]|$)/i;

// By name: the part after the server name ("mcp__x__delete_thing" -> "delete_thing"), matched at word boundaries, so "blockquote" is not a block.
// Tools the manifest lists never get here: their row says what they are.
export const nameIsNever = (tool: string): boolean => NEVER_NAME.test(tool.split("__").pop() ?? tool);

const MAX_DEPTH = 6;

const strings = (v: unknown, depth = 0): string[] =>
  depth > MAX_DEPTH ? [] : Array.isArray(v) ? v.flatMap((x) => strings(x, depth + 1)) : typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap((x) => strings(x, depth + 1)) : [];

// Every [key, value] pair at every depth (bounded).
function* walk(v: unknown, depth = 0): Generator<[string, unknown]> {
  if (depth > MAX_DEPTH || !v || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) yield* walk(x, depth + 1);
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    yield [k, x];
    yield* walk(x, depth + 1);
  }
}
const norm = (k: string): string => k.toLowerCase().replace(/[_-]/g, "");

// A boolean argument that sends something to the bin or to spam, however the tool spells it (snake_case or camelCase).
const BIN_FLAGS = new Set(["spam", "isspam", "intrash", "istrashed", "trashed", "trash", "archived", "allowdeletingcontent"]);

// The arguments put something in TRASH or SPAM: a label value (labelIds, addLabelIds, label_ids, labelOption...; adding trashes, removing untrashes), spam: true,
// in_trash / archived: true (a Notion page to the bin), allow_deleting_content: true (a Notion replace that deletes pages). Generalises the Gmail sensitive-label rule.
export function destinationIsTrashOrSpam(input: Record<string, unknown>, except: ReadonlySet<string> = new Set()): boolean {
  for (const [k, v] of walk(input)) {
    if (except.has(norm(k))) continue; // a flag the tool's module lets the person confirm (confirmedArguments)
    if (/label/i.test(k) && strings(v).some((s) => /^\s*(trash|spam)\s*$/i.test(s))) return true;
    if (BIN_FLAGS.has(norm(k)) && (v === true || (typeof v === "string" && v.trim().toLowerCase() === "true"))) return true;
  }
  return false;
}

// An `action` argument that names a delete (a friend's manage_event with action delete): the same words as the name rule.
export const neverActionValue = (input: Record<string, unknown>, except: readonly string[] = []): boolean =>
  typeof input.action === "string" && NEVER_NAME.test(input.action.trim()) && !except.includes(input.action.trim().toLowerCase());

// The arguments of a call that a module's floor declares confirmable (ConfirmDelete): which flags and action values to leave out of the never-allowed check, and
// whether the call uses one of them (it is then a delete to confirm). Only for the tools the module names.
export function confirmedArguments(tool: string, input: Record<string, unknown>, c: ConfirmDelete | undefined): { flags: ReadonlySet<string>; actions: readonly string[]; hit: boolean } {
  if (!c || !c.tools.includes(tool.split("__").pop() ?? tool)) return { flags: new Set(), actions: [], hit: false };
  const flags = new Set((c.flags ?? []).map(norm));
  const actions = (c.actions ?? []).map((a) => a.toLowerCase());
  const flag = [...walk(input)].some(([k, v]) => flags.has(norm(k)) && (v === true || (typeof v === "string" && v.trim().toLowerCase() === "true")));
  const action = typeof input.action === "string" && actions.includes(input.action.trim().toLowerCase());
  return { flags, actions, hit: flag || action };
}

// ---- local files ----

// No tool may reach local files. Mailbird's create_draft accepts file:// attachments, so an injected email could otherwise get ~/.ssh or .env attached to a draft.
// Any string value that starts with file:, and in an attachments-like field also an absolute or ~ path.
const ABSOLUTE = /^\s*(\/|~|[a-z]:[\\/])/i;
export function namesLocalFile(input: unknown, inAttachments = false, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof input === "string") return /^\s*file:/i.test(input) || (inAttachments && ABSOLUTE.test(input));
  if (Array.isArray(input)) return input.some((x) => namesLocalFile(x, inAttachments, depth + 1));
  if (input && typeof input === "object") return Object.entries(input).some(([k, v]) => namesLocalFile(v, inAttachments || /attach/i.test(k), depth + 1));
  return false;
}
