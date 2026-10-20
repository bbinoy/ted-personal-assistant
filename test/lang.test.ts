import test from "node:test";
import assert from "node:assert/strict";
import { parseLanguages } from "../src/settings.ts";
import { scriptLanguage, unsupportedForVoice, UNSURE, type LanguageModel } from "../src/conversation/lang.ts";
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

test("voice safety net: the script guard settles non-Latin text without a model call", async () => {
  const f = fake("en");
  const ru = "Привет, у тебя сегодня две встречи, первая в десять тридцать, и вторая после обеда.";
  assert.equal(await unsupportedForVoice(ru, ["en"], f.model), "ru");
  assert.equal(await unsupportedForVoice(ru, ["en", "ru"], f.model), undefined);
  assert.equal(f.asked.length, 0);
});

test("voice safety net: long Latin text goes to the model; its language decides", async () => {
  const de = fake("de");
  assert.equal(await unsupportedForVoice(DE, ["en"], de.model), "de");
  assert.equal(await unsupportedForVoice(DE, ["en", "de"], de.model), undefined);
  assert.equal(await unsupportedForVoice(EN, ["en"], fake(" EN-us ").model), undefined);
  assert.equal(de.asked.length, 2);
});

test("voice safety net: short text is let through without a model call", async () => {
  const f = fake("de");
  assert.equal(await unsupportedForVoice("Danke!", ["en"], f.model), undefined);
  assert.equal(await unsupportedForVoice("OK, Termin 14:30 Uhr", ["en"], f.model), undefined);
  assert.equal(f.asked.length, 0);
});

test("voice safety net: no model, a failed model or junk holds the voice back", async () => {
  for (const answer of [new Error("down"), undefined, "", "german", "d3"]) assert.equal(await unsupportedForVoice(DE, ["en"], fake(answer).model), UNSURE, String(answer));
});

test("the voice prompt names the supported languages and says to use text for any other", () => {
  assert.match(voiceOption(true, ["en"]), /speaks only these languages: en\. If your reply is in any other language, answer in text and do not use \[\[voice\]\]/);
  assert.match(voiceOption(true, ["en", "de"]), /languages: en, de\./);
  assert.match(voiceOption(true), /languages: en\./); // the default setting
});
