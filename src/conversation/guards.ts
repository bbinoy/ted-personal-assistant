// The security boundary for incoming Signal messages, as a pure function.
// The linked Signal device sees ALL of the owner's incoming traffic (friends, groups),
// so the agent must only ever act on the owner's own private channel with it: their Note to Self,
// or (when the assistant has its own Signal account) a one-to-one chat with them, never a group.
// "The owner" is a lookup: the sender (her account id, else her number) resolves to a registry record (tenants.ts) with the role admin.
export function acceptOwner(m: { from: string; fromUuid?: string; direct: boolean }, resolve: (who: { number?: string; aci?: string }) => { role: string; status: string } | undefined): boolean {
  if (!m.direct) return false;
  const rec = resolve({ number: m.from || undefined, aci: m.fromUuid });
  return rec?.role === "admin" && rec.status !== "suspended";
}
