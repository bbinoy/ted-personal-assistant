import { createdLabel, idsInCall } from "./created.ts";
import { confirmsDelete, moduleOf } from "../policy/toolmanifest.ts";

// A question about a call that acts on an object by its id (delete or change a calendar event, a Notion page, a Drive file, a mail draft) must name the object, not only the id.
// Written by code, in this order: (1) what the assistant itself made in this conversation and the title and time its creating call gave (created.ts, 24 hours); (2) the
// module's own read-only lookup (ToolModule.describe), where it has a getter and the code has a client for it; (3) for a delete, the plain statement that the title is unknown.
// The line is part of the code-rendered details the question writer and the judge read, and the title must appear in the question (questionfacts.ts).

const HAS_NAME = /^(summary|title|subject|name)$/i;
const named = (input: Record<string, unknown>): boolean => Object.entries(input).some(([k, v]) => HAS_NAME.test(k) && typeof v === "string" && v.trim() !== "");

const LOOKUP_MS = 3000;

export async function objectLines(conversation: string, tool: string, input: Record<string, unknown>, lookup?: (tool: string, input: Record<string, unknown>) => Promise<string | undefined>): Promise<string> {
  if (named(input) || idsInCall(input).length === 0) return ""; // the call says what it is about itself, or it names no object
  const made = createdLabel(conversation, input);
  if (made) return `\nNamed: ${made} (the assistant created it earlier in this conversation)`;
  const find = lookup ?? moduleOf(tool)?.describe;
  if (find) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await Promise.race([find(tool, input), new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), LOOKUP_MS)))]);
      if (found?.trim()) return `\nNamed: ${found.trim().slice(0, 200)}`;
    } catch {
      /* quietly: no label */
    } finally {
      clearTimeout(timer);
    }
  }
  return confirmsDelete(tool, input) ? "\nNamed: unknown (only its id is known: it was not made by the assistant here and could not be looked up)" : "";
}
