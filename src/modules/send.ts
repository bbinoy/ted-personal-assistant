import { rowsOf, type ToolModule } from "./types.ts";

// send (send.ts): a message, voice note, picture (a browse screenshot of this run) or reaction in the conversation the run is for, while it continues.
// It needs a conversation to send to: chat and groups. The conversation's own send changes nothing of the owner's, so it is free and never judged.
export const sendModule: ToolModule = {
  name: "send",
  connection: { kind: "in-process", name: "send", when: (ctx) => !!ctx.key && ctx.offers("mcp__send__send") },
  rows: rowsOf("mcp__send__", "send", "chat")("send", "send", { only: ["chat", "group"] }),
  free: true,
  floor: { judgeNever: ["send"] },
};
