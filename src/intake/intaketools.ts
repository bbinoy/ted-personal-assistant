import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { emitRecord } from "../core/events.ts";
import { baseUrlProblem, connectionState, INTAKE_LINK_TOOL, INTAKE_STATUS_TOOL, LinkStore, linkUrl, purposesFor, readDone } from "./intakelinks.ts";
import { purposeOf } from "./intakepurposes.ts";
import { settings } from "../core/settings.ts";
import { capabilitiesOfRecord } from "../tenants/capabilityset.ts";
import { tenantById, type Capability, type TenantRecord } from "../tenants/tenants.ts";

// A tenant's two tools for the intake page (intakeserver.ts), in her run only (agentrun.ts) and only when her tool set has them (capabilities.ts):
//   get_setup_link   mints a single-use link, valid a few minutes, for ONE purpose, bound to her; the assistant puts it in her chat
//   setup_status     what the page stored, as names and lengths ("stored (N characters)"), never a value
// The model never sees what she types: it goes from her browser to the page to OpenBao. Scope is closed over (her id), never a parameter.

const LINK_MINUTES = 15; // how long a setup link works (once)
const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

export function createIntakeServer(t: { id: string }, links: LinkStore = new LinkStore(), capabilities: (rec: TenantRecord) => ReadonlySet<Capability> = capabilitiesOfRecord) {
  const purposeArg = { purpose: z.string().max(20).describe("What she wants to set up: profile (a saved detail like an address), card, google (connect her own Gmail and Calendar by signing in on Google's page) or notion (connect her own Notion by signing in on Notion's page)") };
  // Her record is read at each call: a purpose that is no longer set up, or a suspension, takes effect at once.
  const mayUse = (purpose: string): string | undefined => {
    const rec = tenantById(t.id);
    if (!rec || rec.status !== "active") return "She cannot use this.";
    const offered = purposesFor([...capabilities(rec)]);
    if (!purposeOf(purpose) || !offered.includes(purpose)) return `She cannot set up "${purpose.slice(0, 20)}" (available: ${offered.join(", ") || "nothing"}).`;
    return undefined;
  };
  return createSdkMcpServer({
    name: "intake",
    version: "1.0.0",
    tools: [
      tool(
        INTAKE_LINK_TOOL.split("__")[2]!,
        `Make a private, single-use setup link where she can type a secret or a saved detail (an address, a passport number, a card) herself, or connect her Google or Notion account by signing in on that service's own page, in her browser. Put the link in your reply and tell her it works once for ${LINK_MINUTES} minutes. Never ask her to type the value in this chat, and do not read it from anywhere: you will never see it. Afterwards setup_status tells you whether it was saved.`,
        purposeArg,
        async ({ purpose }) => {
          const no = mayUse(purpose);
          if (no) return reply(no, true);
          const problem = baseUrlProblem();
          if (problem) return reply(problem[0]!.toUpperCase() + problem.slice(1) + ".", true);
          const code = links.mint({ tenant: t.id, purpose }, LINK_MINUTES * 60_000);
          if (!code) return reply("Too many setup links are open at the moment; try again in a few minutes.", true);
          emitRecord("intake_link", "minted", "group", { tenant: t.id, purpose });
          return reply(`${linkUrl(settings.intake.baseUrl!, code)}\nSingle use, valid ${LINK_MINUTES} minutes, only for "${purposeOf(purpose)!.title}". Send it to her in your reply as it is.`);
        },
      ),
      tool(
        INTAKE_STATUS_TOOL.split("__")[2]!,
        "Whether she has finished a setup form: what was saved, as names and lengths, never a value. Call it after she says she is done.",
        purposeArg,
        async ({ purpose }) => {
          const no = mayUse(purpose);
          if (no) return reply(no, true);
          const done = readDone(t.id, purpose);
          const open = links.isOpen({ tenant: t.id, purpose });
          // A sign-in purpose (Google, Notion): connected or not, never what the connection holds.
          if (purposeOf(purpose)?.oauth) {
            const name = purposeOf(purpose)!.title.replace(/^Connect /, "");
            const c = connectionState(t.id, purpose);
            if (c.state === "connected") return reply(`${name} is connected (since ${c.at}).${open ? " A newer link is open." : ""} Nothing else about it is visible to you.`);
            if (c.state === "reconnect") return reply(`${name} was connected but no longer works (her permission expired or was withdrawn). She has to connect again: make her a new link.${open ? " A link is open already." : ""}`);
            return reply(open ? "Not yet: her link is still open." : "Nothing saved yet, and no link is open.");
          }
          if (!done) return reply(open ? "Not yet: her link is still open." : "Nothing saved yet, and no link is open.");
          return reply(`Stored at ${done.at}: ${done.stored.map((s) => `${s.name} (${s.chars} characters)`).join(", ")}.${open ? " A newer link is open." : ""}`);
        },
      ),
    ],
  });
}
