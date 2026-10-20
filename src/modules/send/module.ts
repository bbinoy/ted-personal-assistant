import { rowsOf, type ToolModule } from "../types.ts";

// send (send.ts): a message, voice note, picture (a browse screenshot of this run) or reaction in the conversation the run is for, while it continues.
// It needs a conversation to send to: the chat turn and the heartbeat run of the owner, a group or a friend (the owner's heartbeat run is policy source "background"). The conversation's
// own send changes nothing of the owner's and reaches nobody else, so it is free and never judged.
export const sendModule: ToolModule = {
  name: "send",
  connection: { kind: "in-process", name: "send", when: (ctx) => (!!ctx.key || ctx.source === "background") && ctx.offers("mcp__send__send") },
  rows: rowsOf("mcp__send__", "send", "chat")("send", "send", { only: ["chat", "group", "background"] }),
  free: true,
  floor: { judgeNever: ["send"] },
};
