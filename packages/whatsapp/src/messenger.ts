import type { DoctorLine, Messenger, MessengerConfig } from "@ted-assistant/messenger";

// Entry point "./messenger": a placeholder for WhatsApp (Business Cloud API) as a Messenger (MESSENGER=whatsapp). Nothing is built yet; the design is in README.md.

/** @throws always: this platform is not built yet */
export async function createMessenger(_config: MessengerConfig): Promise<Messenger> {
  throw new Error("whatsapp messenger is not built yet: see packages/whatsapp/README.md");
}

/** One line for `npm run doctor`: not built yet. */
export async function doctor(_config: { account?: string; options: MessengerConfig["options"] }): Promise<DoctorLine[]> {
  return [{ ok: false, what: "whatsapp", detail: "not built yet: see packages/whatsapp/README.md" }];
}
