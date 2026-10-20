import { rowsOf, type ToolModule } from "../types.ts";

// seen_mail (seenmail.ts): the heartbeat run's memory of which inbox mail it has worked through, whatever the mail provider. Only a heartbeat run of a conversation
// with mail has it (the run hands its tracker to the server, and the expert it calls shares it); it reads and writes that conversation's own bounded log and nothing else, so it
// is free: nothing to judge, nothing to ask.
const seen = rowsOf("mcp__seenmail__", "seenmail", "mail");
export const seenMailModule: ToolModule = {
  name: "seenmail",
  connection: { kind: "in-process", name: "seenmail", when: (ctx) => !!ctx.seenMail && !ctx.browsing },
  rows: seen("seen-mail", "seen_mail", { only: ["background", "group"] }),
  free: true,
};
