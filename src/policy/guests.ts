// Does a call name people: guests of a calendar event, recipients, e-mail addresses? ONE reader of the call's own arguments, by the words in the key, for the
// judge's veto (a call that would email people is never judged), the "Notifies:" line, a friend's Google and the edit-and-approve rule (policy.ts applyChanges).
// The real fields are many (attendees, attendeeEmails, addedAttendees, addedAttendeeEmails, guests, ...), so keys are read case-insensitively by token,
// camelCase or snake_case; a key that REMOVES people (removedAttendeeEmails) names nobody new.

const TOKENS = /^(attendees?|guests?|invitees?|recipients?|to|cc|bcc|emails?)$/;
const REMOVAL = /^(removed?|removing|deleted?)$/;

const keyTokens = (key: string): string[] => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
export const isPeopleKey = (key: string): boolean => {
  const t = keyTokens(key);
  return t.some((x) => TOKENS.test(x)) && !t.some((x) => REMOVAL.test(x));
};

// Something that could be a name or an address: any non-blank string inside (numbers and booleans, like guestsCanModify, name nobody).
const hasText = (v: unknown, depth = 0): boolean =>
  depth > 6 ? false : typeof v === "string" ? v.trim() !== "" : Array.isArray(v) ? v.some((x) => hasText(x, depth + 1)) : v && typeof v === "object" ? Object.values(v).some((x) => hasText(x, depth + 1)) : false;

function walk(v: unknown, depth: number): boolean {
  if (depth > 6) return false;
  if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
  if (!v || typeof v !== "object") return false;
  return Object.entries(v).some(([k, x]) => (isPeopleKey(k) ? hasText(x) : walk(x, depth + 1)));
}

export const namesPeople = (input: Record<string, unknown>): boolean => walk(input, 0);
export const namesNoGuests = (input: Record<string, unknown>): boolean => !namesPeople(input);
