import type { DoctorLine, Messenger, MessengerConfig } from "@ted-assistant/messenger";

// Entry point "./messenger": a placeholder for Telegram (Bot API) as a Messenger (MESSENGER=telegram). Nothing is built yet; the design is in SETUP.md.

/** @throws always: this platform is not built yet */
export async function createMessenger(_config: MessengerConfig): Promise<Messenger> {
  throw new Error("telegram messenger is not built yet: see packages/telegram/SETUP.md");
}

/** One line for `npm run doctor`: not built yet. */
export async function doctor(_config: { account?: string; options: MessengerConfig["options"] }): Promise<DoctorLine[]> {
  return [{ ok: false, what: "telegram", detail: "not built yet: see packages/telegram/SETUP.md" }];
}
