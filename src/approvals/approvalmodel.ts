import { audit, type Source } from "../core/audit.ts";
import { runJudge, withTimeout } from "./approvaljudge.ts";
import type { JudgeIO } from "./judgespare.ts";
import { factsOf, validateQuestion } from "./questionfacts.ts";
import { answerPrompt, parseAnswer, parseWrite, writePrompt, type AnswerJudgement, type OpenView, type Recent } from "./approvalprompt.ts";

// The model calls of approvals. Each one fails closed: a thrown error, a timeout, an error result, an
// answer for the wrong task or one that is not an exact enum value is "no answer" (undefined / inaccurate), never an approval.

// Resolves undefined when the judge gave no usable answer; the caller then treats the reply as a normal chat message.
export async function judgeAnswer(reply: string, open: readonly OpenView[], recent: readonly Recent[], quote?: { id?: string; ended?: boolean; voice?: boolean }, io: JudgeIO = {}, timeoutMs = 20_000): Promise<AnswerJudgement | undefined> {
  const started = Date.now();
  try {
    const r = await withTimeout(runJudge("answer", answerPrompt(reply, open, recent, quote), io), timeoutMs);
    const j = r && parseAnswer(r.out, open.map((o) => o.id));
    console.log(`judge: answer ${j ? `-> ${j.target} ${j.outcome}` : "no usable result"} (${Date.now() - started}ms${r?.warm ? ", warm" : ", cold"})`);
    return j;
  } catch (e) {
    console.error("judge error:", (e as Error).message);
    return undefined;
  }
}

export interface QuestionInput {
  tool: string;
  args: Record<string, unknown>;
  details: string; // the code-rendered text: ground truth for the facts the question must carry; never sent
  recent: readonly Recent[];
  background: boolean;
  source: Source;
}
export type Composed = { text: string; ms: number; by?: "model" } | { text?: undefined; failure: string; ms: number; by?: undefined };

type Run = (prompt: string) => Promise<unknown>;
const viaJudge = (io: JudgeIO, ms: number): Run => async (prompt) => (await withTimeout(runJudge("write", prompt, io), ms))?.out;

// ONE model call writes the question, always in the owner's language; code checks that every address, URL, id, title, time, date, amount
// and the words Cc / Bcc from the exact arguments appear in it (questionfacts.ts) and that no address or URL outside the arguments and details does. If anything
// fails (error, timeout, junk, a missing fact) there is NO question and no retry: the caller does not ask, the action is not
// approved, and the failure is audited with the full arguments. Never throws.
export async function composeQuestion(q: QuestionInput, io: JudgeIO = {}, timeoutMs = 15_000, run: Run = viaJudge(io, timeoutMs)): Promise<Composed> {
  const started = Date.now();
  const facts = factsOf(q.args, q.details);
  let failure: string;
  try {
    const text = parseWrite(await run(writePrompt({ ...q, required: facts.must })));
    const wrong = text ? validateQuestion(text, facts) : "no usable question from the writer";
    if (text && !wrong) return { text, ms: Date.now() - started, by: "model" };
    failure = wrong!;
    audit(q.tool, "question-failed", q.source, { reason: failure, question: text, details: q.details });
  } catch (e) {
    failure = (e as Error).message;
    audit(q.tool, "question-failed", q.source, { reason: failure, details: q.details });
  }
  console.log(`question: not asked (${failure})`);
  return { failure, ms: Date.now() - started };
}
