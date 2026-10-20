// Small helpers several test files used to define for themselves.

import type { Source } from "../src/audit.ts";
import { availableFor, isFree, type MailProvider } from "../src/policy/toolmanifest.ts";
import type { JudgeSetup } from "../src/approvals/permissions.ts";
import { scopeOf } from "../src/approvals/turnscope.ts";

// What the manifest says about a tool for a source (what the one path in permissions.ts starts from): undefined = the tool does not exist there
// (denied outright), "free" = runs without the judge (a read, the assistant's own plumbing), "judged" = goes floor -> judge -> approval question.
export const access = (tool: string, source: Source, mail?: MailProvider): "free" | "judged" | undefined => (!availableFor(tool, source, mail) ? undefined : isFree(tool, mail) ? "free" : "judged");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One short turn of the event loop for queued work (timers, a settled promise chain) to run.
export const tick = () => sleep(5);

// A promise and the function that settles it, for holding a fake step open until the test says go.
export const defer = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

// The judge setup of a run started from the owner's own chat (what agentrun.ts gives it): their recent messages are the provenance (turnscope.ts).
export const CHAT: JudgeSetup = { provenance: scopeOf("owner").read, conversation: "owner" };

// The provenance of a job with fixed text (RunOptions.provenance).
export const standing = (task: string): JudgeSetup["provenance"] => () => ({ kind: "standing", task });
