// The silent marker: a run that has nothing to say answers [[silent]]. Models slip ("SILENT", "(silent)", "**[[SILENT]]**"),
// so every place that decides silence asks here. Pure.

export const SILENT = "[[silent]]";

// The whole text is only the marker, in any slipped form: any case, with brackets, quotes, asterisks or punctuation around it.
const BARE = /^[\s"'`*_()[\]{}<>.,!:;-]*silent[\s"'`*_()[\]{}<>.,!:;-]*$/i;

export const isSilent = (text: string): boolean => BARE.test(text);

// The exact marker anywhere in a message (a heartbeat answer that mentions it is silent), or the text is only a slipped form.
export const hasSilent = (text: string): boolean => text.toLowerCase().includes(SILENT) || isSilent(text);

// The text without the exact marker (any case), trimmed: words a model wrote beside it still go out, an empty rest sends nothing.
export const withoutSilent = (text: string): string => text.replace(/\[\[silent\]\]/gi, "").trim();
