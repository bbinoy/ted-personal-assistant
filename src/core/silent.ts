// The silent marker: a run that has nothing to say answers [[silent]]. Models slip ("SILENT", "(silent)", "**[[SILENT]]**"),
// so every place that decides silence asks here. Pure.

export const SILENT = "[[silent]]";

// The whole text is only the marker, in any slipped form: any case, with brackets, quotes, asterisks or punctuation around it.
const BARE = /^[\s"'`*_()[\]{}<>.,!:;-]*silent[\s"'`*_()[\]{}<>.,!:;-]*$/i;

// A text that is only a JSON object or array (bare or in a code fence) is no words for a person: a run that echoed its structured answer as text
// (e.g. {"nextCheckMinutes":30}) says nothing.
const asJson = (text: string): boolean => {
  const t = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
  if (!/^[[{][\s\S]*[\]}]$/.test(t)) return false;
  try {
    return typeof JSON.parse(t) === "object";
  } catch {
    return false;
  }
};

export const isSilent = (text: string): boolean => BARE.test(text) || asJson(text);

// The text without the exact marker (any case), trimmed: words a model wrote beside it still go out, an empty rest sends nothing.
export const withoutSilent = (text: string): string => text.replace(/\[\[silent\]\]/gi, "").trim();
