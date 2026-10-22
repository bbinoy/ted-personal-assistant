import { splitArchive } from "../modules/archivecap.ts";
import { clip } from "../core/sanitize.ts";
import { settings } from "../core/settings.ts";
import { mailName } from "./journalrender.ts";

// The floor of the gentle first week, the part that runs INSIDE a look: while a look is in shadow mode (shadow.ts decides that, from the conversation's age and notes), the archives it makes are
// not made. permissions.ts asks this gate right after the archive cap; an archive call (archivecap.ts says which calls are one, for every mail provider) is collected here, split to one call per
// mail, and refused with a sentence for the model. The look's end then proposes the collected mail in ONE message (shadow.ts). Nothing the model writes decides what is collected: the tool, the
// arguments and the subject and sender lines are code's (the lines are read from the connector's own results, journalrender.ts), so the proposal cannot be steered by the mail it is about.

export type ShadowGate = (tool: string, input: Record<string, unknown>) => string | undefined;

export interface Proposed {
  tool: string;
  input: Record<string, unknown>; // ONE mail, the call exactly as the look made it
  id: string;
  line: string; // “Subject” from Sender, as the connector gave them
}
export interface ShadowRun {
  gate: ShadowGate;
  proposed: () => Proposed[];
}

export const heldText = (): string =>
  `Not archived, and nobody was asked: ${settings.owner} is in the first days with you, so archives are proposed, not made. That mail is noted, and every archive of this look goes to ${settings.owner} as ONE proposal when the look ends. ` +
  "Carry on with the rest of the look, do not look for another way to archive it, and do not say you archived it (at most: you proposed it).";

// The line for one mail: the subject and sender the look has read, else the bare id. One line, bounded, no control characters (clip).
export const lineFor = (conv: string, id: string): string => mailName(conv, id) ?? `mail ${clip(id, 40)}`;

export function createShadowRun(conv: string): ShadowRun {
  const items = new Map<string, Proposed>();
  return {
    gate(tool, input) {
      const calls = splitArchive(tool, input);
      if (calls.length === 0) return undefined; // not an archive
      for (const c of calls) if (c.id && !items.has(c.id)) items.set(c.id, { tool, input: c.input, id: c.id, line: lineFor(conv, c.id) }); // (a call that names no id has nothing to propose: refused all the same)
      return heldText();
    },
    proposed: () => [...items.values()],
  };
}
