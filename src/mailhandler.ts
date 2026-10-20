import { capabilitiesOf, toolsFor } from "./policy/capabilities.ts";
import type { Conversation } from "./conversationmodel.ts";
import { loaded, mailModule } from "./modules/index.ts";
import type { MailTools, ToolModule } from "./modules/types.ts";

// WHICH tools a conversation's background mail handler (handler.ts) works with: the mail-tools module whose rows the conversation has. The owner's are her mail
// provider's (Mailbird, Gmail; MAIL_PROVIDER=none: none); a friend's are the module whose tools her capability set offers (her Google). A module has a handler when
// its MailTools say what the standing task is (`handlerTask`): there is no other flag, so a provider that can draft has one, whichever it is.
export interface MailHandler {
  module: ToolModule;
  tools: MailTools & { handlerTask: NonNullable<MailTools["handlerTask"]> };
}

type Who = Pick<Conversation, "kind" | "tenantId">;

export function mailHandlerOf(conv: Who): MailHandler | undefined {
  const pick = (m: ToolModule | undefined): MailHandler | undefined => {
    const tools = m && (m.mail ?? m.mailTools);
    return m && tools?.handlerTask ? { module: m, tools: tools as MailHandler["tools"] } : undefined;
  };
  if (conv.kind === "owner") return pick(mailModule());
  const offered = toolsFor(capabilitiesOf(conv));
  return pick(loaded().find((m) => !m.slot && m.mailTools && m.rows.some((r) => offered.has(r.tool))));
}

// The standing task of this conversation's handler for `who`.
export const handlerTaskFor = (conv: Who, who: string): string => {
  const h = mailHandlerOf(conv);
  if (!h) throw new Error("this conversation has no mail handler");
  return h.tools.handlerTask(who);
};

// The tools of a friend's handler run: those of her mail module (its calendar rows included: one server), from her capability set.
export const handlerToolsOf = (conv: Who, tools: ReadonlySet<string>): Set<string> => {
  const h = mailHandlerOf(conv);
  const rows = new Set(h?.module.rows.map((r) => r.tool));
  return new Set([...tools].filter((t) => rows.has(t)));
};
