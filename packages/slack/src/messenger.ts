import type { DoctorLine, Messenger, MessengerConfig } from "@ted-personal-assistant/messenger";

// Entry point "./messenger": a placeholder for Slack (Socket Mode) as a Messenger (MESSENGER=slack). Nothing is built yet; the design is in SETUP.md.

/** @throws always: this platform is not built yet */
export async function createMessenger(_config: MessengerConfig): Promise<Messenger> {
  throw new Error("slack messenger is not built yet: see packages/slack/SETUP.md");
}

/** One line for `npm run doctor`: not built yet. */
export async function doctor(_config: { account?: string; options: MessengerConfig["options"] }): Promise<DoctorLine[]> {
  return [{ ok: false, what: "slack", detail: "not built yet: see packages/slack/SETUP.md" }];
}
