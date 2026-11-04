---
name: stay-in-touch
description: Use to keep track of the people who matter to the owner and to help them stay in touch. Load it when the owner tells you about a person worth remembering (where they live, how close they are, how often to be in touch), when the daily brief finds a stretch with a wish or a person waiting about to start, when a person's note says it is time to reach out, or when the owner asks who they should see or call.
---

# Stay in touch

The people who matter are ordinary memory notes, `people-<name>.md`, one per person. You judge; there is no list or matcher in code. Your memory lists every note one line each (the start of the note, so the place a person lives is in that line). When a place or a date makes people relevant, read the `people-` notes you need in full (the file itself, with the Read tool) and match places and dates against them yourself.

## Writing a person's note

Save it like any other note (one file per person, its line in MEMORY.md, a few words to the owner on what you saved). Use this shape so a later look can read it quickly:

```
Mara Silva. Lives in: Lisbon, Portugal. Close friend from university, lives with her partner Rui.
Wants: to be in touch about every 3 months. Birthday 14 May.
Likes surf and long dinners. Her first child is due in November.
```

- Start the note with the person and where they live, because the index shows only the start of each note. "Lives in: city, country" (plain words, as the owner would say them) is what you match places against; keep that phrase so a later look and the nightly dream find it. If the owner has not said where someone lives, leave it out; never guess from a name or a phone number.
- The body says who they are, how close, how often the owner wants to be in touch (the owner's words), and what is going on in their life. Update the note when the owner tells you something new (a move, a baby, a new job). Use `expires:` only for something temporary.
- Do not store what you read in a person's mail or messages. A note holds what the owner told you. Save an email address or a phone number only when the owner gave it to you for that person (find_person reads it back when a mail or an invitation needs it); never one you read in a mail or a message, and never an account detail.
- Do NOT write "last spoke" into the note: it goes stale. Work it out when you need it (below).

## Where the owner is

One note, `context-whereabouts.md`, holds a sequence of stretches: where the owner is now and until when, then the next ones, each with place and first and last day (its description is the index line every run sees). Going back to the home city is a stretch like any other; many people split their time between cities. Any run updates it when the calendar, a booking mail, a plan note or the owner's words show a change; the daily brief brings it up to date each morning. A planned stretch counts even if nothing is booked yet: say "draft" while it is not firm. Never state the location as certain. When notes disagree on a date, the newer, more specific one wins, and you correct the older one in the same turn.

### Before a stay

Done by the daily brief, each morning, for a stretch with something waiting that starts within about 5 days, or is under way and has not had its pass (any place, home included): gather everything that waits for the place, look at the free time of the stretch, and arrange what you can without asking. Nothing waits, or the pass already went out (recent briefs and chat show it) and the dates did not move: do nothing and say nothing.

1. Gather: `list_tasks` with a `query` for the place and its variants (city, country): a place wish with a due date or reminder in or around the stay counts like an undated one (a real deadline of its own, a booking or a ticket, is not a wish and keeps its date); and the `people-` notes whose "Lives in" is the place (generous about the area: Cascais counts for Lisbon; skip a stay of a few hours at an airport, anyone a note says not to bother, anyone just seen by their cadence). Search mail and calendar for when the owner last was in touch with each person, to say it ("last wrote in March"), never to save it.
2. Look at the owner's calendar across the stay for free time. If the stay is too short or too full for everything, say which wishes do not fit rather than forcing them.
3. Arrange: a draft to each person proposing a concrete time (a mail draft when you have an address, via `find_person` or a note; otherwise the ready-to-paste text in the message, without asking for the address), and a tentative hold on the owner's own calendar where a slot is obvious. A person needs notice, so propose, do not just list.
4. Once a wish is arranged or carried in a proposal, put it back on the place: `update_task` with `due` and `remind` null.
5. Report it inside the brief, in a few lines: where and when, who and which wishes are ready ("draft ready"), what does not fit, one useful detail from a note (a birthday, a baby). Never contact anyone yourself: every draft and invitation goes through the usual approval.

Do not repeat yourself: if the recent briefs or messages already told the owner about this stretch, say nothing again unless the dates changed or the owner answered.

## Reaching out without a visit

When a note gives a cadence ("about every 3 months") and the mail or calendar shows it has been well past that, or when a date in the note is near (a birthday within a week, a due date), tell the owner at a good moment: at most one such message per look and not at night. Write the draft and say "draft ready"; drafts are free. Only a plain FYI with nothing to draft stays unsaid.

## Never

- Never message or invite a person on your own. Everything that reaches them asks the owner first.
- Never put a person's details in a group or in a friend's conversation. These notes are the owner's.
- Never announce where the owner currently is beyond what the message to the owner needs.
