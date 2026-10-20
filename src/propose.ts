import { audit } from "./audit.ts";
import { proposalText, viewDraft, type DraftView } from "./proposals.ts";

// Shows the handler's reply drafts to the owner on Signal (see proposals.ts for how they are sent).

export interface Mail {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
}

export type DraftId = number | string; // (Mailbird's ids are numbers, Gmail's are text)

// For the handler's hook: remembers the id of each reply draft a tool call created. Which calls create one, and where their id is, is the mail module's to say
// (modules/types.ts MailTools.createdDraft).
export function draftCollector(created: (tool: string, response: unknown) => DraftId | undefined = () => undefined) {
  const ids: DraftId[] = [];
  return {
    ids,
    onToolSuccess(tool: string, _input: unknown, response?: unknown) {
      const id = created(tool, response);
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    },
  };
}

// `read`: the draft as the mail client holds it now (Gmail's readers), or `mail` (Mailbird's get_message).
export function createProposer(deps: { mail?: Mail; read?: (draftId: DraftId) => Promise<DraftView | undefined>; send: (text: string) => Promise<number> }) {
  // The draft as the mail client holds it now. Also what the approval prompt for a send is built from.
  async function read(draftId: DraftId): Promise<DraftView | undefined> {
    if (deps.read) return deps.read(draftId);
    return viewDraft(await deps.mail!.call("get_message", { messageId: draftId }));
  }

  // Shows each draft on Signal. A draft that cannot be read, or has no recipient, is skipped:
  // it is still in the owner's mailbox as a draft.
  async function show(draftIds: readonly DraftId[]): Promise<number> {
    let shown = 0;
    for (const id of draftIds) {
      try {
        const view = await read(id);
        if (!view || view.to.length === 0) continue;
        await deps.send(proposalText(view, id));
        audit("reply_proposal", "shown", "handler", { id });
        shown++;
      } catch (e) {
        console.error("proposal: could not show a draft:", (e as Error).message);
      }
    }
    return shown;
  }

  return { show, read };
}
