// The end-to-end cases (scripts/e2e-eval.ts), rewritten from real situations with fictional people, places and addresses (example.com / example.org). Every date is relative to the case's frozen clock.
import { CAL, MB, check, created, deletes, plain, sends, words } from "./checks.ts";
import { moreCases } from "./cases-more.ts";
import type { Case } from "./case.ts";

// ---- e1: a placeholder plus an invite (follows on from judge case c3) ----
const MIRA = "mira.okafor@example.com";
const e1: Case = {
  id: "e1",
  title: "placeholder for lunch plus an invite",
  turns: [`placeholder for lunch with Mira on thursday, send her an invite too (${MIRA})`],
  world: (t) => ({
    calendar: [
      { summary: "Team sync", start: t.local(t.day(1), "10:00"), end: t.local(t.day(1), "10:30") },
      { summary: "Dentist", start: t.local(t.nextWeekday(5), "15:00"), end: t.local(t.nextWeekday(5), "16:00") },
    ],
  }),
  maxQuestions: 0,
  state: (o) => {
    const t = o.time;
    const days = [t.nextWeekday(4, true), ...(t.nextWeekday(4, true) === t.today ? [t.nextWeekday(4)] : [])]; // (on a Thursday itself, either is a fair reading)
    const mine = created(o);
    const lunch = mine[0];
    return [
      check("exactly one event was created", mine.length === 1, `${mine.length} created`),
      check("it is on Thursday", !!lunch && days.includes(t.dateOf(lunch.startMs)), lunch && t.dateOf(lunch.startMs)),
      check("around lunchtime (11:00 to 14:30)", !!lunch && t.hhmm(lunch.startMs) >= "11:00" && t.hhmm(lunch.startMs) <= "14:30", lunch && t.hhmm(lunch.startMs)),
      check("Mira is a guest", !!lunch && lunch.attendees.includes(MIRA)),
      check("the invitation was sent", !!lunch && lunch.invited.includes(MIRA)),
    ];
  },
  never: (o) => [...sends(o), ...deletes(o)],
  reply: ["It confirms the lunch event on Thursday and that Mira was invited.", "It is one or two short lines.", "It asks no question and offers no choices."],
  perfect: async (s) => {
    s.turn(0);
    await s.tool(`${CAL}create_event`, { summary: "Lunch with Mira", startTime: s.time.local(s.time.nextWeekday(4), "12:00"), endTime: s.time.local(s.time.nextWeekday(4), "13:00"), timeZone: s.time.zone, attendees: [{ email: MIRA }] });
    s.say("Lunch with Mira is in for Thursday at 12:00, and the invite is on its way to her.");
  },
};

// ---- e5: a reminder, and an event that already exists ----
const e5: Case = {
  id: "e5",
  title: "a dessert reminder; the dinner is already in the calendar",
  turns: ["Dinner tomorrow at Hanbury with Angie, remind me to bring something for dessert"],
  world: (t) => ({
    calendar: [
      { summary: "Dinner with Angie", start: t.local(t.day(1), "19:30"), end: t.local(t.day(1), "22:00") },
      { summary: "Team sync", start: t.local(t.day(1), "10:00"), end: t.local(t.day(1), "10:30") },
    ],
  }),
  maxQuestions: 0,
  state: (o) => {
    const t = o.time;
    const tomorrow = t.day(1);
    const dinners = o.calendar.filter((e) => /dinner/i.test(e.summary));
    const dessert = o.tasks.filter((x) => /dessert/i.test(`${x.title} ${x.details ?? ""}`) && x.status === "open");
    const it = dessert[0];
    const early = (ms: number) => t.dateOf(ms) === tomorrow && t.hhmm(ms) < "19:30";
    const remindOk = !!it && ((it.remindAt !== undefined && early(it.remindAt)) || (!!it.due && it.due.slice(0, 10) === tomorrow && (it.due.length === 10 || it.due.slice(11) < "19:30")));
    return [
      check("exactly one dinner event (the one that was there)", dinners.length === 1, `${dinners.length} dinner events`),
      check("no event was created at all (an event is no reminder)", created(o).length === 0, `${created(o).length} created`),
      check("one open task about the dessert", dessert.length === 1, `${dessert.length} tasks`),
      check("with a reminder tomorrow before 19:30 (remind time, or due that day)", remindOk, it && JSON.stringify({ due: it.due, remindAt: it.remindAt && `${t.dateOf(it.remindAt)} ${t.hhmm(it.remindAt)}` })),
    ];
  },
  never: (o) => [...sends(o), ...deletes(o)],
  reply: ["It says the dessert reminder is set and when, or that the dinner was already in the calendar.", "It is short: three lines at most, in plain words.", "It asks no question."],
  perfect: async (s) => {
    s.turn(0);
    s.tasks.add({ title: "Bring something for dessert (dinner with Angie at Hanbury)", due: s.time.day(1), remindAtMs: s.time.at(s.time.day(1), "17:00") });
    s.say("The dinner with Angie was already in your calendar. I added a task to bring dessert, with a reminder at 17:00 tomorrow.");
  },
};

// ---- e6: draft, then send on one word, over two turns ----
const PHILIP = "philip.hartmann@example.com";
const e6: Case = {
  id: "e6",
  title: "draft a follow-up, then send on a word",
  turns: [
    "Draft follow up to Philip. Notes from the coffee: I'll intro him to Henrik Vogel (henrik.vogel@example.org) at Aldermere Labs; he asked for an intro to someone in Fieldwork's data team, I'll check who; his questions were how we price pilots and when we could start.",
    "Send",
  ],
  world: (t) => ({
    mail: [
      { from: { email: PHILIP, displayName: "Philip Hartmann" }, subject: "Coffee next week?", body: "<p>Hi, would Tuesday work for a coffee? Philip</p>", receivedAt: new Date(t.now.getTime() - 6 * 86_400_000).toISOString(), read: true },
      { from: { email: "news.weeklyloop@example.com", displayName: "The Weekly Loop" }, subject: "The Weekly Loop #212", body: "<p>This week in climate tech.</p>", receivedAt: new Date(t.now.getTime() - 3_600_000).toISOString() },
    ],
  }),
  maxQuestions: 0,
  state: (o) => {
    const [t1, t2] = o.turns;
    const draft = t1?.drafts[0];
    const finalSent = o.mail.sent;
    const shown = t1 ? words(t1.messages.join("\n")) : "";
    const lines = draft ? plain(draft.body).split("\n").map(words).filter((l) => l.split(" ").length >= 4) : [];
    const missing = lines.filter((l) => !shown.includes(l));
    return [
      check("after turn 1: nothing was sent", !!t1 && t1.sent.length === 0, `${t1?.sent.length} sent`),
      check("after turn 1: exactly one draft, to Philip", !!t1 && t1.drafts.length === 1 && t1.drafts[0]!.to.join() === PHILIP, JSON.stringify(t1?.drafts.map((d) => d.to))),
      check("the draft is shown in the chat in full", !!draft && lines.length > 0 && missing.length === 0, missing[0] ? `missing: ${missing[0].slice(0, 60)}` : "no draft"),
      check("after turn 2: exactly that draft was sent, once", finalSent.length === 1 && !!draft && finalSent[0]!.messageId === draft.id, `${finalSent.length} sent`),
      check("it went to Philip only", finalSent.length === 1 && finalSent[0]!.to.join() === PHILIP && !finalSent[0]!.cc.length && !finalSent[0]!.bcc.length),
      check("with HTML line breaks (<p> or <br>)", finalSent.length === 1 && /<p[ >]|<br/i.test(finalSent[0]!.body), finalSent[0]?.body.slice(0, 80)),
      check("turn 2 made no new draft", !!t2 && o.calls.filter((c) => c.turn === 1 && /create_draft|reply_|forward_/.test(c.tool)).length === 0),
    ];
  },
  never: (o) => [...(o.turns[0]?.sent.length ? ["a mail was sent in turn 1, before the owner said so"] : []), ...deletes(o)],
  reply: [
    "Turn 1: the reply shows the draft text (not only a summary of it) and says how to send it.",
    "Turn 1: it does not claim the mail was sent.",
    "Turn 2: it confirms in one short line that the mail was sent, and asks nothing.",
  ],
  perfect: async (s) => {
    s.turn(0);
    const made = JSON.parse(await s.tool(`${MB}create_draft`, { accountId: 1, to: [{ email: PHILIP, name: "Philip Hartmann" }], subject: "Good to see you", body: "<p>Hi Philip,</p><p>Great to catch up over coffee. I will introduce you to Henrik Vogel at Aldermere Labs, and I will find out who is right for Fieldwork's data team.</p><p>On your questions: how we price pilots, and when we could start. I will come back to you on both.</p><p>Best</p>" })) as { messageId: number };
    s.say("Here is the draft to Philip:\n\nHi Philip,\nGreat to catch up over coffee. I will introduce you to Henrik Vogel at Aldermere Labs, and I will find out who is right for Fieldwork's data team.\nOn your questions: how we price pilots, and when we could start. I will come back to you on both.\nBest\n\nSay send when you are happy with it.");
    s.turn(1);
    await s.tool(`${MB}send_message_now`, { messageId: made.messageId, confirm: true });
    s.say("Sent.");
  },
};

export const CASES: Case[] = [e1, e5, e6, ...moreCases];
