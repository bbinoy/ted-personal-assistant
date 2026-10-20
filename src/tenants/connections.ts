import { connectionState } from "../intake/intakelinks.ts";
import { PURPOSES } from "../intake/intakepurposes.ts";
import { capabilitiesOfRecord } from "./capabilityset.ts";
import type { Capability, TenantRecord } from "./tenants.ts";

// Which of her own accounts a person has connected (Google, Notion: the sign-in purposes of the intake page), for the admin's list and the doctor. Whether, and since
// when, never what the connection holds (and only for a service that is set up: otherwise she has nothing to connect): no token is read for this (the intake page's record of names and times, intakelinks.ts connectionState).

export const connectionServices = (capabilities: ReadonlySet<Capability>): string[] => Object.entries(PURPOSES).filter(([, p]) => p.oauth && capabilities.has(p.capability)).map(([id]) => id);

const day = (iso: string | undefined): string => (iso ?? "").slice(0, 10);

// "google connected since 2026-10-20, notion not connected yet"; undefined when she has no service to connect.
export function connectionSummary(rec: TenantRecord): string | undefined {
  const parts = connectionServices(capabilitiesOfRecord(rec)).map((p) => {
    const c = connectionState(rec.id, p);
    return `${p} ${c.state === "connected" ? `connected since ${day(c.at)}` : c.state === "reconnect" ? `needs to be reconnected (since ${day(c.at)})` : "not connected yet"}`;
  });
  return parts.length ? parts.join(", ") : undefined;
}
