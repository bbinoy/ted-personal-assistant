import type { RunKind } from "../src/core/runkind.ts";

// The kinds of run the tests ask about (src/core/runkind.ts): who it is for and whether someone waits for the answer.
export const OWNER_CHAT: RunKind = { who: "owner", attended: true }; // the owner's chat turn
export const OWNER_LOOK: RunKind = { who: "owner", attended: false }; // the owner's look (and anything it starts)
export const GROUP_CHAT: RunKind = { who: "group", attended: true }; // a group's chat turn
export const GROUP_LOOK: RunKind = { who: "group", attended: false };
export const FRIEND_CHAT: RunKind = { who: "tenant", attended: true }; // a friend's chat turn
export const FRIEND_LOOK: RunKind = { who: "tenant", attended: false };
export const BROWSE_RUN: RunKind = { who: "browse", attended: true }; // the browse worker of an attended run

// The old source names some tests still loop over, as the kind of run each stood for (an unattended owner run for every background name).
export const kindOf = (name: string): RunKind => (name === "chat" ? OWNER_CHAT : name === "group" ? GROUP_CHAT : name === "browse" ? BROWSE_RUN : OWNER_LOOK);
