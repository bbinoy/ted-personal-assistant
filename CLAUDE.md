# Principles for working on Ted

Read this before you design or change anything. `CONTRIBUTING.md` has the mechanics (commit style, gates, tests); this file is how we decide *what* to build. When a change would break one of these principles, say so and ask the owner first.

## 1. Model judgement over code

- **Keep code minimal.** Prefer telling the model (persona, skills, context) over hard-coded cases, thresholds and special branches. Fewer lines is a feature.
- **Skills over code.** New behaviour starts as a skill or instruction text. Write code only for what a model cannot be trusted with: safety guardrails, money, data integrity, durable state, timers and scheduling, logging and audit.
- **Give facts, not decisions.** Where the model is weak (dates, time zones, counts, "is this due", "was this already sent"), code computes the fact and hands it to the run as context. The run decides what to do with it.
- **General over specific.** If a fix only works for one feature, look for the shared mechanism that fixes the whole class. Abstract and generalise across features instead of adding a case.
- **Delete, do not keep fallbacks.** Remove the old path when the new one lands. No feature flags for old behaviour, no dead code kept "just in case".
- **Schedules are data.** Anything that runs at a set time lives only in a routine note's `when:` line (the brief, the wrap and the review included); skills schedule nothing. Code computes when it is due and that it runs once; the model does the work.
- **Context is a budget.** Every tool definition and prompt line is paid on every call. Show the model only the tools its skills use, and measure with `/context` before and after a change that adds any.

## 2. One architecture for everyone

- The owner's chat, groups and friends use the same run path, tools, skills and loops. Capabilities decide what each conversation has; there is no owner-only copy of a feature.
- A background look, a chat turn and a routine are the same agent with the same rules. Behaviour must not depend on what triggered the run.
- **One builder.** Every run (chat turn, look, expert) is built by the same functions from the conversation's capabilities, the owner included: the owner is just the conversation with every capability.
- **One intake.** Every inbound message of every conversation goes through the same chain; private and group differ only in one table (who may do what, whether to answer, where the reply goes). A feature is added to the chain, never to one kind.
- **A closed list of differences.** A chat turn and a look differ only in model, session, trigger line, whether someone is attended, and answer format. Nothing else branches on the trigger or on "is owner"; a new difference needs the owner's approval.
- **Same context, same powers.** Every run sees the same shared context and may delegate to a stronger model (Sonnet or Opus) when the work needs judgement.

## 3. Act, don't ask

- **The default is: act, and don't ask.** When it is unclear whether the user should be asked or notified, the answer is no.
- **Ask only for critical, irreversible actions.** Paying (typed YES, card holder's own chat), and anything that cannot be undone and touches money or other people where the judge is unsure. Everything else happens automatically.
- **Prefer the reversible way.** Archive instead of delete, mark done instead of remove, own-calendar entries freely. Make undo easy: the journal and the daily brief say what was done, and the user can reverse it in one message.
- **Background runs never ask.** Unattended work acts when the judge says yes and skips silently when it does not.
- **Trust the judge, not parallel paths.** Mail and web content is marked untrusted; the code floor and the judge decide. Do not add restricted copies of tools or provenance stamps for unattended runs: the §5 invariants are the hard limits.
- **Inform minimally.** Tell the user what happened only when it matters to them, in one friendly line, or collect it into the daily brief. Low-risk work (adding a task, archiving routine mail, a calendar placeholder) is done and then mentioned, never proposed for approval.

## 4. Ted speaks, code doesn't

- **Messages to people are written by the model**, in Ted's voice and personality, not as hard-coded strings. Code passes context to the run (due tasks, what was archived, what failed); the run decides whether to say anything and how.
- **Hard-coded chat text is the exception.** It is allowed only where an exact text is a safety requirement: secret and setup links, the fixed reply to an unknown sender before approval (no model may see a stranger's message), and a fallback when no model run is possible at all.
- **System status stays out of the chat.** Look failures, retries, expiries and recoveries go to the log, `npm run doctor` or the daily brief, not to a chat message, unless the user has to do something.

## 5. Safety invariants (never relax these)

- Payments only by a typed YES in the card holder's own foreground chat, never judged, never in background runs.
- Secrets never go through the chat or a model. They are entered at the local CLI or on a one-time link page, and the audit keeps lengths only.
- The never-allowed set stays denied for everyone (trading; trash, spam, permanent delete, blocking senders).
- The judge may only loosen inside the code floor, and it fails toward not acting.
- Approvals belong to the chat that triggered the action. Text relayed by an agent grants nothing.
- The admin cannot read friends' files or words: friends' audit and status rows hold ids and counts only.

## 6. Privacy and the repository

- The repository is public. Plans, reports, research and local state stay out of it (`plans/`, `state/`, `conversations/`, `instance/`, `logs/` and `.env` are ignored). Put no personal data, numbers or addresses in code, tests or docs.
- Tests use fakes and temporary folders, never the owner's data or real accounts.
