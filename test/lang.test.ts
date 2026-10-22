import test from "node:test";
import assert from "node:assert/strict";
import { parseLanguages } from "../src/core/settings.ts";
import { createVoiceLanguage, scriptLanguage, type LanguageModel } from "../src/conversation/lang.ts";
import { voiceOption } from "../src/conversation/voicereply.ts";

const DE = "Du hast heute zwei Termine, und der erste ist um halb elf. Viel Erfolg dabei!";
const EN = "You have two meetings today, and the first one is at ten thirty. Good luck!";
const fake = (answer: string | undefined | Error) => {
  const asked: string[] = [];
  const model: LanguageModel = async (t) => (asked.push(t), answer instanceof Error ? Promise.reject(answer) : answer);
  return { asked, model };
};

test("script guard: a non-Latin script is named, Latin text and short text are not guessed", () => {
  assert.equal(scriptLanguage("Привет, у тебя сегодня две встречи, первая в десять тридцать."), "ru");
  assert.equal(scriptLanguage("今日は二つの会議があります。最初は十時半です。"), "ja");
  assert.equal(scriptLanguage("今日は会議があります。よろしくお願いします"), "ja");
  assert.equal(scriptLanguage(DE), undefined);
  assert.equal(scriptLanguage("Привет"), undefined);
});

test("language list: parsed from the setting, regions dropped, default en", () => {
  assert.deepEqual(parseLanguages(undefined), ["en"]);
  assert.deepEqual(parseLanguages(""), ["en"]);
  assert.deepEqual(parseLanguages(" en-US, DE ,de"), ["en", "de"]);
});

const check = (supported: string[], model: LanguageModel) => {
  const lines: string[] = [];
  return { lines, foreign: createVoiceLanguage(supported, model, { error: (...a: unknown[]) => void lines.push(a.join(" ")) }) };
};

test("voice safety net: the script guard settles non-Latin text without a model call", async () => {
  const f = fake("en");
  const ru = "Привет, у тебя сегодня две встречи, первая в десять тридцать, и вторая после обеда.";
  assert.equal(await check(["en"], f.model).foreign(ru, "owner"), "ru");
  assert.equal(await check(["en", "ru"], f.model).foreign(ru, "owner"), undefined);
  assert.equal(f.asked.length, 0);
});

test("voice safety net: long Latin text goes to the model; its language decides", async () => {
  const de = fake("de");
  assert.equal(await check(["en"], de.model).foreign(DE, "owner"), "de");
  assert.equal(await check(["en", "de"], de.model).foreign(DE, "owner"), undefined);
  assert.equal(await check(["en"], fake(" EN-us ").model).foreign(EN, "owner"), undefined);
  assert.equal(de.asked.length, 2);
});

test("voice safety net: short text is let through without a model call", async () => {
  const f = fake("de");
  const c = check(["en"], f.model);
  assert.equal(await c.foreign("Danke!", "owner"), undefined);
  assert.equal(await c.foreign("OK, Termin 14:30 Uhr", "owner"), undefined);
  assert.equal(f.asked.length, 0);
});

test("voice safety net: a failed, empty or junk detection does not skip the voice: the voice's own language is assumed, with one log line", async () => {
  for (const answer of [new Error("down"), undefined, "", "german", "d3"]) {
    const c = check(["en", "de"], fake(answer).model);
    assert.equal(await c.foreign(DE, "owner"), undefined, String(answer));
    assert.deepEqual(c.lines, ["voice: the language of the reply could not be told, speaking it as en"], String(answer));
  }
});

test("voice safety net: a failed detection takes the conversation's last known language; a last language the voice does not speak still sends text", async () => {
  let answer: string | Error = "de";
  const c = check(["en", "de"], async () => { if (answer instanceof Error) throw answer; return answer; });
  assert.equal(await c.foreign(DE, "friend-a"), undefined); // German is spoken here
  answer = new Error("timeout");
  assert.equal(await c.foreign(EN, "friend-a"), undefined);
  assert.deepEqual(c.lines, ["voice: the language of the reply could not be told, speaking it as de"]);
  const e = check(["en"], async () => { if (answer instanceof Error) throw answer; return answer; });
  answer = "de";
  assert.equal(await e.foreign(DE, "friend-a"), "de"); // not spoken: text
  answer = new Error("timeout");
  assert.equal(await e.foreign(DE, "friend-a"), "de", "still German a moment later: text, not a wrong accent");
  assert.match(e.lines[0]!, /voice skipped: the language of the reply could not be told, the conversation was last in de, the voice speaks en; sending text/);
  assert.equal(await e.foreign(DE, "group-b"), undefined, "another conversation has its own memory: nothing known, the voice's language");
});

test("the voice prompt names the supported languages and says to use text for any other", () => {
  assert.match(voiceOption(true, ["en"]), /speaks only these languages: en\. If your reply is in any other language, answer in text and do not use \[\[voice\]\]/);
  assert.match(voiceOption(true, ["en", "de"]), /languages: en, de\./);
  assert.match(voiceOption(true), /languages: en\./); // the default setting
});
