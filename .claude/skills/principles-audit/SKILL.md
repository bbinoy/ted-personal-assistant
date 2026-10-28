---
name: principles-audit
description: Audit the code against the principles in CLAUDE.md with three parallel read-only reviewers and one verified, ranked list. Use when the owner asks for a principles, simplicity or architecture audit.
disable-model-invocation: true
---

# Principles audit

Start three read-only subagents in parallel (`ted-reviewer`), and a fourth when the owner asks for it (below). Each reads CLAUDE.md first, never the private folders, edits nothing, and returns ranked findings. Each finding: file:line evidence, the principle broken, a recommendation, size (S/M/L) and confidence (low/medium/high).

1. **Proactivity and helpfulness** (§3 and §4): places that ask when they should act, code-written chat text, system status leaking into chat, background runs that ask.
2. **One architecture** (§2): owner, group or friend special cases, branches on trigger or "is owner", features added to one kind instead of the shared chain or builder, fixes for one case instead of the class.
3. **Simplicity, model judgement, context budget** (§1): hard-coded cases and thresholds a skill could say, fallbacks and dead code, schedules outside a routine's `when:` line, tool definitions or prompt lines that cost context without being used.
4. **Notes that should be shared defaults** (owner's request only; it needs a local `Read(./conversations/owner/notes/**)` allow in `.claude/settings.local.json`; never a group's or friend's notes, §5): which of the owner's notes state general behaviour rather than personal taste or facts, whether the shared skills or persona already cover them (then the note can go), and several notes saying the same thing (the shared default is wrong). Report each as a generic rule for a named skill or persona file, with no personal details.

Then, as lead, open the code behind the top findings and confirm or drop each one. Present one list ranked by value over size, with the verified evidence. Do not change code; the owner picks what to build.
