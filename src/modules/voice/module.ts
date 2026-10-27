import { settings } from "../../core/settings.ts";
import { rowsOf, type ToolModule } from "../types.ts";

// voice (voicetool.ts): the conversation's own cloned voice, Qwen only. Needs a conversation.
export const voiceModule: ToolModule = {
  name: "voice",
  connection: { kind: "in-process", name: "voice", when: (ctx) => !!ctx.key && settings.tts.provider === "qwen" && ctx.offers("mcp__voice__voice") },
  rows: rowsOf("mcp__voice__", "voice", "voice")("voice", "voice"),
  free: true,
};
