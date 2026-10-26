// Kept apart from events.ts so that the sinks can use it without importing the module that imports them.

// What a permission decision came to, in the words of the approval path: the call is allowed, asked, denied, approved by the judge ("auto-approved") or by a person ("approved"), declined,
// or failed. The decision strings of the audit log say more (ask-sent, judge-ask, deny-policy...); this is the
// part the journal cares about.
export type ToolStep = "allow" | "ask" | "deny" | "auto-approved" | "approved" | "declined" | "failed";

// Pure: the step an audit decision string stands for, or undefined for the bookkeeping rows between steps (judge-ask, approval-asked, answer-fast...).
export function stepOf(decision: string): ToolStep | undefined {
  if (decision === "allow") return "allow";
  if (decision === "ask-sent") return "ask";
  if (decision.startsWith("deny-")) return "deny";
  if (decision === "auto-approved") return "auto-approved";
  if (decision === "ask-approved" || decision === "ask-approved-modified") return "approved";
  if (decision === "ask-declined" || decision === "ask-feedback") return "declined";
  if (decision === "ask-failed") return "failed";
  return undefined;
}
