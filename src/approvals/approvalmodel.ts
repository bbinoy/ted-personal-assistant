import type { Source } from "../core/audit.ts";
import { emitRecord } from "../core/events.ts";
import { runJudge } from "./approvaljudge.ts";
import type { JudgeIO } from "./judgespare.ts";
import { factsOf, validateQuestion } from "./questionfacts.ts";
import { judgeContext } from "./judgecontext.ts";
import { peopleFor } from "./seennames.ts";
import type { Provenance } from "./autojudge.ts";
import { answerPrompt, checkPrompt, parseAnswer, parseCheck, parseWrite, writePrompt, type AnswerJudgement, type OpenView, type Recent } from "./approvalprompt.ts";

// The model calls of approvals. Each one fails closed: a thrown error, a timeout, an error result, an
// answer for the wrong task or one that is not an exact enum value is "no answer" (undefined / inaccurate), never an approval.

// Resolves undefined when the judge gave no usable answer; the caller then treats the reply as a normal chat message.
export async function judgeAnswer(reply: string, open: readonly OpenView[], recent: readonly Recent[], quote?: { id?: string; ended?: boolean; voice?: boolean }, io: JudgeIO = {}): Promise<AnswerJudgement | undefined> {
  const started = Date.now();
  try {
    const r = await runJudge("answer", answerPrompt(reply, open, recent, quote), io);
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
  source: Source;
  conversation?: string; // the conversation key: the names its reads gave to addresses in the call (seennames.ts)
  provenance?: Provenance; // whose words led to the call, as the action judge reads it (permissions.ts)
  untrusted?: boolean;
  typedYes?: boolean; // a card payment: only a typed yes approves it; its question is checked like any other
}
export type Composed = { text: string; ms: number; by?: "model" } | { text?: undefined; failure: string; ms: number; by?: undefined };

type Run = (prompt: string) => Promise<unknown>;
const viaJudge = (task: "write" | "check", io: JudgeIO): Run => async (prompt) => (await runJudge(task, prompt, io))?.out;

// ONE model call writes the question, always in the owner's language; code checks that every address, URL, id, title, time, date, amount
// and the words Cc / Bcc from the exact arguments appear in it (questionfacts.ts) and that no address or URL outside the arguments and details does. If anything
// fails (error, timeout, junk, a missing fact, a judge check that finds it unfaithful to the call) there is NO question and no retry (but a question the judge's check refuses gets ONE rewrite with the reason): the caller does not ask, the action is not
// approved, and the failure is audited with the full arguments. Never throws.
export async function composeQuestion(q: QuestionInput, io: JudgeIO = {}, run: Run = viaJudge("write", io), check: Run = viaJudge("check", io)): Promise<Composed> {
  const started = Date.now();
  const facts = factsOf(q.args, q.details);
  // ONE context for the writer and the check (and the action judge before them): the same facts, so the check can accept what the writer was given
  const context = judgeContext({ details: q.details, provenance: q.provenance, untrusted: q.untrusted, recent: q.recent, names: q.conversation ? peopleFor(q.conversation, `${JSON.stringify(q.args)}\n${q.details}`) : [] });
  let failure: string;
  try {
    let refused: string | undefined; // the judge's reason for a first question it refused: the writer gets ONE more try with it (errors never retry)
    for (;;) {
      const text = parseWrite(await run(writePrompt({ tool: q.tool, args: q.args, context, required: facts.must, refused })));
      const wrong = text ? validateQuestion(text, facts) : "no usable question from the writer";
      if (!text || wrong) {
        failure = wrong!;
        emitRecord(q.tool, "question-failed", q.source, { reason: failure, question: text, details: q.details });
        break;
      }
      // The judge guards the question: it must show the call faithfully (every recipient, attachment, the full text verbatim).
      const raw = await check(checkPrompt({ context, question: text }));
      const c = parseCheck(raw);
      if (c.faithful) return { text, ms: Date.now() - started, by: "model" };
      failure = `the question did not show the call faithfully (${c.reason}); rewrite it showing every recipient, every attachment and the full text verbatim`;
      emitRecord(q.tool, "question-failed", q.source, { reason: failure, question: text, details: q.details });
      const answered = (raw as { faithful?: unknown } | null | undefined)?.faithful === false;
      if (refused !== undefined || !answered) break; // a second refusal, or no usable check: no question
      refused = c.reason;
    }
  } catch (e) {
    failure = (e as Error).message;
    emitRecord(q.tool, "question-failed", q.source, { reason: failure, details: q.details });
  }
  console.log(`question: not asked (${failure})`);
  return { failure, ms: Date.now() - started };
}
