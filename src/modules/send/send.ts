import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { emitRecord } from "../../core/events.ts";
import { isOneEmoji } from "../../core/reaction.ts";
import { dropShots, loadShot } from "./shots.ts";
import { setAsking, type Asking } from "../voice/voicenote.ts";
import { sourceOfKey } from "../../core/ownerkey.ts";

// send: the model's way to put something in the conversation NOW while it keeps working: a message ("On it, researching now"), a voice note,
// a picture (a screenshot of this run's browse, or a drawing from the draw tool), or an emoji reaction. Text the model writes before a tool call stays internal; only this tool
// sends. Every conversation's chat turn has it, and so does its heartbeat run (and the expert that run calls, which inherits the run's tools): the SAME tool, the same
// delivery and the same floor (free: it reaches only the conversation the run belongs to, never a recipient of the model's choosing). The browse worker, the dream and
// compaction do not (agentrun.ts, toolmanifest.ts). The final reply stays the default last message and needs no tool call.
// ONE kind of content per call (text, optionally spoken; a picture, optionally with a caption; or a reaction), any number of calls in any order.
// Delivery is the conversation's own (conversation.ts runTurn, the same function as the final reply): sanitiser, target, quote and thread rules,
// the voice language check, group rules, typing, logging. How often to send is the model's call; the run's turn, budget and time limits bound a runaway loop.

export type Content =
  | { kind: "text"; text: string; voice: boolean } // voice: speak it (the delivery falls back to text when it cannot)
  | { kind: "picture"; file: string; caption: string; id: string; size: number }
  | { kind: "reaction"; emoji: string }; // on the message being answered

// Delivers one piece of content of the running turn; returns what the model is told.
export type SendSink = (c: Content) => Promise<string>;

const sinks = new Map<string, SendSink>();

// An unattended run's sink may have a GATE (heartbeat/look.ts): asked with each text before it is delivered, it returns what the model is told when the text is HELD instead (quiet hours,
// the day's cap: heartbeat/notices.ts), or undefined to let it go. Tied to the run's own sink, so a chat turn of the same conversation (another sink) is never held.
export type SendGate = (text: string, urgent: boolean) => string | undefined;
const gates = new WeakMap<SendSink, SendGate>();
export function gateSink(key: string, gate: SendGate): void {
  const sink = sinks.get(key);
  if (sink) gates.set(sink, gate);
}

// Around a conversation's turn: the sink is found by key while it runs (a warm process is built before its turn exists); afterwards the
// turn's screenshots are removed.
// A run that starts while another is under way (a heartbeat run during a chat turn) takes the sink over and gives it back when it ends.
export async function withSend<T>(key: string, sink: SendSink | undefined, run: () => Promise<T>, asking?: Asking): Promise<T> {
  const before = sinks.get(key);
  if (sink) sinks.set(key, sink);
  if (asking) setAsking(key, asking); // who is asking in this turn (the voice tool records the requester)
  try {
    return await run();
  } finally {
    if (sink && sinks.get(key) === sink) (before ? sinks.set(key, before) : sinks.delete(key));
    dropShots(key);
    if (asking) setAsking(key, undefined);
  }
}

export interface SendArgs {
  text?: string;
  voice?: boolean;
  picture?: string;
  caption?: string;
  react?: string;
  urgent?: boolean; // a background look only: time-critical, goes out at once also in quiet hours and past the day's cap
}

// The tool body, apart from the server so tests can call it. Checks which combination makes sense, then hands the content to the turn's sink.
export async function sendNow(key: string, a: SendArgs): Promise<string> {
  const source = sourceOfKey(key);
  const kinds = [a.text !== undefined, a.picture !== undefined, a.react !== undefined].filter(Boolean).length;
  if (kinds !== 1) return "Send exactly one thing per call: text (add voice: true to speak it), a picture (id, optional caption), or react (one emoji). Call send again for more.";
  if (a.voice !== undefined && a.text === undefined) return "voice only goes with text.";
  if (a.caption !== undefined && a.picture === undefined) return "caption only goes with a picture.";
  const sink = sinks.get(key);
  if (!sink) return "Nobody to send it to right now.";
  let content: Content;
  if (a.text !== undefined) {
    content = { kind: "text", text: a.text, voice: !!a.voice };
  } else if (a.react !== undefined) {
    if (!isOneEmoji(a.react.trim())) return "react takes exactly one emoji.";
    content = { kind: "reaction", emoji: a.react.trim() };
  } else {
    const r = loadShot(key, a.picture!);
    if ("problem" in r) {
      emitRecord("send", "refused", source, { kind: "picture", id: a.picture!.slice(0, 20), conversation: source });
      return r.problem;
    }
    content = { kind: "picture", file: r.shot.file, caption: a.caption ?? "", id: r.shot.id, size: r.shot.size };
  }
  if (content.kind === "text") {
    const held = gates.get(sink)?.(content.text, !!a.urgent);
    if (held) return held;
  }
  try {
    const told = await sink(content);
    emitRecord("send", "sent", source, { kind: content.kind, conversation: source, ...(content.kind === "picture" ? { id: content.id, size: content.size } : {}) });
    return told;
  } catch (e) {
    emitRecord("send", "failed", source, { kind: content.kind, conversation: source, ...(content.kind === "picture" ? { id: content.id, size: content.size } : {}) });
    console.error(`${source}: send ${content.kind} failed:`, (e as Error).message);
    return "Could not send it; carry on.";
  }
}

export function createSendServer(key: string) {
  return createSdkMcpServer({
    name: "send",
    version: "1.0.0",
    alwaysLoad: true, // its schema is in the prompt from the first call: a deferred tool is only found by searching for it, and the model never does
    tools: [
      tool(
        "send",
        "Put one thing in the conversation right now while you keep working: text (add voice: true to speak it), picture (the id of a browse screenshot like shot1 or a drawing like img1, with an optional caption) or react (one emoji on the message you are answering). One thing per call. When to use it is in your instructions.",
        {
          text: z.string().min(1).max(2000).optional().describe("The message, as you would write it in the chat."),
          voice: z.boolean().optional().describe("With text: speak it as a voice note instead (only the voice languages; otherwise it goes out as text)."),
          picture: z.string().min(1).max(20).optional().describe("A screenshot id from the browse result (shot1) or a drawing id from the draw tool (img1)."),
          caption: z.string().max(300).optional().describe("With picture: one short line."),
          react: z.string().min(1).max(16).optional().describe("One emoji, on the message you are answering."),
          urgent: z.boolean().optional().describe("Only in your own periodic look: true if the text is truly time-critical and cannot wait; otherwise at night or past the day's limit it is held and delivered later. Default false."),
        },
        async (a) => ({ content: [{ type: "text" as const, text: await sendNow(key, a) }] }),
        { alwaysLoad: true },
      ),
    ],
  });
}
