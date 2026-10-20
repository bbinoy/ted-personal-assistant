// A reply the model chose to SPEAK starts with "[[voice]]", followed by the words to say aloud.
// Same shape as the emoji reaction (reaction.ts): strict and only at the very start, so ordinary
// text can never be mistaken for it. Pure.

import { settings } from "../core/settings.ts";

const MARK = /^\s*\[\[voice\]\]\s*/i;

// { voice, text }: the words to speak (if the model chose to speak), or the text to send.
export function splitVoice(reply: string): { voice?: string; text: string } {
  const m = MARK.exec(reply);
  return m ? { voice: reply.slice(m[0].length).trim(), text: reply.slice(m[0].length).trim() } : { text: reply };
}

// How the words for a voice message are written. A speech engine reads text literally, so the model writes for the ear:
// this is left to the model on purpose (no code rewrites the text), and the character of the voice comes from the persona and notes.
export const SPOKEN_STYLE =
  "Write the spoken words for the ear, not the eye: short sentences, the way a person talks, with a natural pause (a comma or a full stop) wherever a speaker would breathe, and the warmth and energy of your usual style; spell out everything a person would say differently from how it is written (numbers, dates, times, money, symbols, abbreviations, names of letters, and emphasis), for example \"ten thirty tomorrow morning\", never \"10:30 AM\", no parentheses, and never any emoji, since the voice cannot say them and they would sound strange read out loud: put the feeling into words instead";

// The voice option, added to every prompt that can produce a reply whenever speech is set up (private chat, group
// messages addressed or not, wake-ups): the model chooses freely, whatever kind of message it answers. The notes
// can overrule this default ("never use voice", "voice for pep talks").
const voiceInvite = (languages: readonly string[]): string =>
  "you may answer by voice by starting your reply with [[voice]] and then only the words to say aloud, plain and at most about three minutes spoken (no markdown, emoji, links or lists); good for warm, personal or spoken-style replies such as a pep talk or a joke; keep exact, long or detailed answers (times, figures, links, lists) in text. Never read out a web address or a list of sources in a voice message: the spoken words may say that the sources or links come as a text message, and you send those as a separate text message with the send tool. If the notes say how to use voice (or never to), follow them. The voice speaks only these languages: " + languages.join(", ") + ". If your reply is in any other language, answer in text and do not use [[voice]], since the voice would read it with the wrong accent. " +
  SPOKEN_STYLE;
// Added to the words when a reply the model chose to speak had to go out as text, since the model may have announced a voice message.
export const VOICE_FAILED_NOTE = "(voice didn't work this time, sending text)";
export const voiceOption = (canSpeak: boolean, languages: readonly string[] = settings.ttsLanguages): string => (canSpeak ? `Voice: ${voiceInvite(languages)}.` : "");
