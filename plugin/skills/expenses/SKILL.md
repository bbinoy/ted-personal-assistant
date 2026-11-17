---
name: expenses
description: Use when the person asks to expense a trip, collect receipts or "what do I need to claim", and when a trip has just ended and an expense task exists. Builds one expense pack (merged receipts and a table) in one mail draft instead of a long back and forth. Pairs with `ted-personal-assistant:mail`, `ted-personal-assistant:web-research`, `ted-personal-assistant:workbench` and `ted-personal-assistant:tasks`.
---

# Trip expenses

One job, one pack, one draft, one message. Act, never ask what a tool can do.

1. **The trip.** Find its dates, places and bookings in the calendar, the notes and mail ("the trip to Basel, 4 to 5 May"). Do not ask for what they say.
2. **Every cost.** Search mail (2-3 differently phrased queries, the trip's dates, hotels, rail, taxis, meals): receipts and invoices first, attachments opened with `open_file`, then booking confirmations. A booking whose receipt sits on a website (a link, an order page, a "Print receipt" button): open it with `browse` and have the page saved as a PDF, as web-research says. Never tell the person to print, download or forward anything the browser can do.
3. **The pack.** Merge every PDF (each mail attachment and each saved page, all opened with `open_file` so they are in the box) into one file with the workbench (`qpdf`), check the page count equals the sum, and read the amounts from the documents. The merged file comes back with an id (file3): get that id from the expert and attach by it, never by a path in the box. Make a short table: date, what, amount, currency, and the total per currency. Never state a figure you did not read.
4. **One draft.** To where the person sends expenses (their notes or an earlier expense mail). If neither has it, in any run (a chat turn or a look): ask the person once, in one short message, for the address (a plain question, not an approval), draft nothing to a guess, and when they answer save it as a note and use it from then on without asking. The draft carries the pack (the single merged PDF; the loose files if merging fails) and the table in the body. A new mail, since there is no thread. List what is missing ("hotel invoice, asked for at checkout") in the body and in your reply, and add a waiting-on task (`owed_to_me`, person, title) for each, so nothing is lost.
5. **One message.** What is in the pack, the total per currency ("CHF 123.70", counting an amount read from a page even if its PDF is missing), what is missing, then "say send". Show the draft as the mail skill says. Sending follows the normal approval.
6. **When a step fails** (a file error, a page that will not save): retry once, differently (another file name, a fresh snapshot). Then go on with what works and say in one line what is missing. Never start over, never make a second draft because a part is missing. A draft you replaced is left alone and not offered again; if the missing item arrives later, update your one draft.
