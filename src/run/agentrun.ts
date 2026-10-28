import { query, type HookCallbackMatcher, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { gated, parked, type RunKind as GateKind } from "../core/rungate.ts";
import { auditSource, type RunKind } from "../core/runkind.ts";
import { emitRecord, endRun } from "../core/events.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { noteDone } from "../approvals/journalrender.ts";
import type { TenantRun } from "../tenants/tenanttools.ts";
import { UNSCOPED_KEY } from "../core/ownerkey.ts";
import { charge, envFor, observe, payerFor, succeeded, type Payer } from "../tenants/payer.ts";
import { BROWSE_SCHEMA, browseSystem } from "../modules/browse/browse.ts";
import { resultText, withText, type BrowseGuard } from "../modules/browse/browseguard.ts";
import { HIDDEN_BROWSER_TOOLS } from "../modules/browse/browserules.ts";
import { onStop, pausing, RunTimeout, withCeiling, type Ceiling } from "./ceiling.ts";
import { carriedTaint, chatResume, forgetUnresumable, sessionTaint } from "./chatsession.ts";
import { recordConnectors } from "../modules/connectors.ts";
import { failure } from "../tenants/errors.ts";
import { isNotePath, noteSavedHint, parseNote, STATUS_PREFIX, writeIndex } from "../memory/notes.ts";
import { recordLook } from "../memory/learned.ts";
import { routineNoteReply } from "../modules/tasks/routinelist.ts";
import { builtinModule } from "../modules/builtin.ts";
import { createsOf } from "../policy/toolmanifest.ts";
import { callLabel, idsInResult, noteCreated } from "../approvals/created.ts";
import { serversFor } from "../modules/runtime.ts";
import type { RunContext } from "../modules/types.ts";
import { approveIn, editedNote, makeCanUseTool, type Approve } from "../approvals/permissions.ts";
import type { RunProvenance } from "../approvals/autojudge.ts";
import { scopeOf } from "../approvals/turnscope.ts";
import { browseTools, runCapabilities, toolsFor } from "../policy/capabilities.ts";
import { hiddenTools } from "../policy/policy.ts";
import { type ChatSession } from "./session.ts";
import { settings } from "../core/settings.ts";
import { cleanToolOutput } from "../core/toolclean.ts";
import { readSession, writeSession } from "./sessionstore.ts";
import type { ConvId } from "../core/convpaths.ts";
import { skillsFor } from "../modules/skills.ts";
import { recordToolsSeen, toolsSeen } from "../policy/toolsseen.ts";
import type { SeenMail } from "../modules/seenmail/seenmail.ts";
import { delegationHook, type Delegation, type ExpertSetup } from "./delegation.ts";

// The core of every agent run: its options (RunOptions, buildOptions), the stream consumer, the ceiling every run passes, runAgent, and the
// browse sub-run. The options of a conversation come from one builder (runoptions.ts), the entry points are agent.ts, the warm processes agentwarm.ts.

export interface AgentReply {
  text: string;
  costUsd: number;
  structured?: unknown; // the run's constrained JSON output, when it asked for one
}

export interface RunOptions {
  kind: RunKind; // who the run is for and whether someone waits for it (core/runkind.ts): the tools, the isolation and the asking all follow from these two facts
  systemPrompt: string;
  sessionConv?: ConvId; // continue + save the conversation's session here (its assistant.db); the browse worker: none, a fresh run
  freshSession?: boolean; // a run that never resumes or saves its session (a look): sessionConv still names the conversation
  conversation?: string; // the conversation the run acts for (its key; runFor always says; else the tenant's or group's of this run, none for a bare isolated run). Keys the per-conversation anti-repeat state (permissions.ts)
  // The SDK's auto-memory, for every run of a conversation: notes in `dir`, the only place the file tools may write (policy.ts); its MEMORY.md is code's (notes.ts writeIndex).
  memory?: { dir: string; zone?: string; groupId?: string };
  seenMail?: SeenMail; // a heartbeat run of a conversation with mail: the tracker behind the seen_mail tool (seenmail.ts)
  groupId?: string; // a group's run: its send, its browse approvals and its questions go there
  seenAt?: string; // groups: stored with the session, see ChatSession.seenAt
  skills?: readonly string[]; // the skills offered: skillsFor(capabilities) (skills.ts); the owner's are the whole plugin
  tools?: ReadonlySet<string>; // the tools that exist for the run, from its conversation's capabilities and its attendance (capabilities.ts toolsFor): decides its built-ins, its MCP servers and policy.ts classify
  model?: string; // this run's own model (the heartbeat run's HEARTBEAT_MODEL); default HARNESS_MODEL
  effort?: Options["effort"]; // this run's reasoning effort (the heartbeat profile: high); default the SDK's
  maxTurns: number;
  maxBudgetUsd: number; // hard per-run spend cap. Per RUN, not per session: the SDK does not count the cost a resumed session already had (checked), so owner and groups alike need no adjustment here. The previous total is subtracted only when reporting cost (consume)
  outputFormat?: Options["outputFormat"]; // constrained JSON output
  // Fires after a tool call succeeds. Used to capture the brief the agent sends.
  onToolSuccess?: (tool: string, input: unknown, response?: unknown) => void;
  onFirstOutput?: () => void; // the model's first message arrived (timing only)
  guard?: BrowseGuard; // the browse run: decides each browser call and remembers the page (browse.ts)
  gate?: GateKind; // its place in the run gate (rungate.ts), default a look's; the browse run is a CHILD of a run that already holds a place, so it never queues for another
  stopScope?: string; // what "/stop" names to reach this run (ceiling.ts stopRuns): the conversation's id
  signal?: AbortSignal; // an unattended run is called off from outside (a chat message overtook the heartbeat look, look.ts): while waiting for a place (rungate.ts) it never starts, once running the query is aborted
  maxMinutes?: number; // a wall-clock ceiling of its own (the browse run), else RUN_MAX_MINUTES_CHAT, the same for every run of a conversation
  // Whose words or which text started the run, for the approval judge (autojudge.ts RunProvenance). Set by the code that starts the run, a function because it is
  // read at every call (a warm process is built before the message that uses it arrives): a job passes `() => ({ kind: "standing", task })` with its fixed text, an
  // unattended turn of a conversation `derived` text (turnscope.ts derivedTurn). A conversation's own turn passes nothing: its turn-scoped messages are its scope's
  // (turnscope.ts scopeOf, keyed by the conversation). The browse sub-run inherits its parent's.
  provenance?: () => RunProvenance | undefined;
  untrusted?: boolean; // the run reads raw mail or web pages from its first call (the mail handler, the browse worker): told to the approval judge
  // A tenant's run (tenants.ts): an isolated "group" run on HER OWN Anthropic API key, with her own cost ledger and cooldown. Never absent for a run
  // made for a tenant, and never given the instance's login: without a key the run does not start.
  tenant?: TenantRun;
  // The experts every run may delegate heavy work to (run/delegation.ts, set by the builder). Gives the run the Agent tool, the SDK `agents` and the PreToolUse hook that
  // allows only these agents, at most two per run and no nesting, and keeps a `delegate:` skill out of the run's own hands. `onDelegate` is told each accepted delegation.
  experts?: { setup: ExpertSetup; onDelegate?: (d: Delegation) => void; context?: () => string | undefined }; // context: code-written, appended to every brief (a look's facts and recent chat)
}

// Who pays for a run (payer.ts): a friend's run is on the instance key and her ledger, any other on the login.
const payerOf = (opts: Pick<RunOptions, "tenant" | "kind" | "groupId" | "memory">): Payer => (opts.tenant ? { kind: "instance", id: opts.tenant.id, apiKey: opts.tenant.apiKey, ledger: opts.tenant.ledger } : payerFor({ kind: opts.kind.who, groupId: opts.groupId ?? opts.memory?.groupId }));

// Context size of one model call: everything it was sent.
const contextTokens = (u: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

// The browse sub-run (browse.ts calls this through the entry tool): a fresh run with the browser, under the guard. A group's run is the same
// as the owner's; only `approve` differs (the group's own approver).
export function browseRunOptions(guard: BrowseGuard, tenant?: TenantRun, parent: Pick<RunOptions, "provenance" | "conversation" | "signal" | "stopScope"> & { attended?: boolean } = {}): RunOptions {
  return {
    gate: "helper", // (a child of a run that holds a place: queuing for a second one could deadlock the looks that browse, and make a chat turn wait behind them)
    signal: parent.signal, // called off with its parent (a look overtaken by a message, a ceiling)
    stopScope: parent.stopScope, // and by "/stop" in the parent's conversation
    kind: { who: "browse", attended: parent.attended ?? true }, // the worker of an unattended run asks nobody either
    systemPrompt: browseSystem(undefined, guard.profileKeys(), guard.cardInfo()),
    maxTurns: settings.browseMaxTurns,
    maxBudgetUsd: settings.browseMaxUsd,
    maxMinutes: settings.browseMaxMinutes,
    outputFormat: BROWSE_SCHEMA,
    provenance: parent.provenance, // the words that started the run it works for; its own task is the assistant's (judgeSetup browseTask), added next to them
    conversation: parent.conversation,
    untrusted: true, // it reads hostile pages
    guard,
    tenant, // the browse worker of a tenant's run is hers too: her key, her ledger (it would otherwise be billed to the instance's login)
  };
}

// The `run` of a browse entry tool (browse.ts BrowseContext): the browse run under its guard, asking `approve` for commit steps.
export const browseRunner = (approve: Approve, tenant?: TenantRun, parent: Pick<RunOptions, "provenance" | "conversation" | "signal" | "stopScope"> & { attended?: boolean } = {}) => (prompt: string, guard: BrowseGuard): Promise<AgentReply> => runAgent(prompt, approve, browseRunOptions(guard, tenant, parent));

// The built-in tools of a run (everything else is an MCP tool): the rows of the builtin module (modules/builtin.ts) that its tool set holds. 
function builtinTools(tools: ReadonlySet<string>): string[] {
  return builtinModule.rows.filter((r) => tools.has(r.tool)).map((r) => r.tool);
}

export function buildOptions(approve: Approve, opts: RunOptions, resume: string | undefined, signal?: AbortSignal, run: string = randomUUID()): Options { // signal: the run's own abort signal, when the caller has it (its browse child is called off with it)
  // After a successful tool call: announce a note change on the phone (chat), and report the
  // call to whoever asked (the brief captures what it sent).
  // The notes this run has read so far, in order (its Read of a note reports each): the journal says "per your notes: ..." for what it does next (journalrender.ts whyOf).
  const notesSeen: string[] = [];
  const afterTool = async (tool: string, input: Record<string, unknown>, response?: unknown) => {
    const notes = opts.memory?.dir;
    if (notes && isNotePath(input.file_path, notes)) {
      const name = input.file_path.split("/").pop()!.replace(/\.md$/, "");
      if (tool === "Read" && input.file_path.endsWith(".md") && name !== "MEMORY" && !notesSeen.includes(name)) notesSeen.push(name);
      if (tool === "Write" || tool === "Edit") {
        writeIndex(notes, new Date(), opts.memory?.zone); // a note changed: the index is code's, made again from the notes (whatever the model wrote there is replaced)
        const file = input.file_path.split("/").pop()!;
        if (!kind.attended && opts.sessionConv && file !== "MEMORY.md" && !file.startsWith(STATUS_PREFIX)) { // a look changed a note while nobody watched: told in "what I learned overnight" (learned.ts)
          try {
            const note = parseNote(file, readFileSync(input.file_path, "utf8"));
            if (note) recordLook(opts.sessionConv, file, tool === "Write", note.description ?? note.text.split("\n")[0]!, Date.now());
          } catch { /* the note is gone again: nothing to tell */ }
        }
      }
    }
    if (createsOf(tool, input)) noteCreated(conversation, idsInResult(response), Date.now(), callLabel(input)); // what the assistant made here, so a later delete of it can be told to the judge (created.ts)
    void noteDone({ conv: conversation, run, source: auditSource(opts.kind), tool, input, response }); // the journal line of an action, with the why the permission layer recorded (core/events.ts)
    opts.onToolSuccess?.(tool, input, response);
  };
  const delegation = opts.experts ? delegationHook(opts.experts.setup, auditSource(opts.kind), { onDelegate: opts.experts.onDelegate, context: opts.experts.context }) : undefined;
  const hooks: Partial<Record<"PreToolUse" | "PostToolUse", HookCallbackMatcher[]>> = {
    ...(delegation ? { PreToolUse: [{ hooks: [delegation.hook] }] } : {}),
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PostToolUse") return {};
            await afterTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, input.tool_response);
            // A routine note was written: the model is told at once how its schedule was read and when it runs, or that it cannot run (tasks/routines.ts).
            // A note was saved in a turn someone waits on: the result says to mention it, so even a reply that is only a reaction says what was saved (the persona asks the same).
            const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
            const additionalContext = editedNote(conversation, input.tool_name, toolInput) ?? routineNoteReply(input.tool_name, toolInput, opts.memory?.dir, opts.memory?.zone) ?? (opts.kind.attended ? noteSavedHint(input.tool_name, toolInput, opts.memory?.dir) : undefined);
            // The browse run: a page view is read into the result (the server only links its snapshot file), cut to size and remembered
            // by the guard (the refs, the real names of the controls, what was typed) before it is cleaned like any other result.
            let response: unknown = input.tool_response;
            if (opts.guard && input.tool_name.startsWith("mcp__browser__")) {
              const shot = input.tool_name.endsWith("take_screenshot") ? opts.guard.keepShot(response) : undefined; // a picture the chat may pass on (shots.ts)
              const shaped = opts.guard.shape(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, resultText(response));
              if (shaped !== undefined) response = withText(response, shaped);
              if (shot) response = withText(response, `${resultText(response)}\n(This is ${shot}. If it shows what the task is about, list it in the result's shots with a one-line caption.)`);
            }
            // Clean at the door: the model reads the cleaned result, not the original (counts only in the log).
            const cleaned = cleanToolOutput(input.tool_name, response);
            if (!cleaned) return response === input.tool_response && !additionalContext ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse" as const, ...(response === input.tool_response ? {} : { updatedToolOutput: response }), ...(additionalContext ? { additionalContext } : {}) } };
            console.log(`clean: tool result ${input.tool_name}: ${cleaned.removed} hidden character(s) removed, ${cleaned.hidden} hidden HTML part(s) left out, ${cleaned.cut} cut`);
            return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: cleaned.output, ...(additionalContext ? { additionalContext } : {}) } };
          },
        ],
      },
    ],
  };

  // A group or tenant run: no connectors, no user settings; its tools are its capability set (capabilities.ts), its MCP servers are those of that set, and
  // the skills are the shared ones its capabilities allow.
  const { kind } = opts;
  const browsing = kind.who === "browse"; // the browse sub-run: the browser and web search, nothing of the owner's
  const caps = runCapabilities(kind); // (a run built by runFor carries its conversation's tools and skills, which come from the same set)
  const login = caps.has("login"); // the instance's own Claude login (the owner's): its connectors and user settings. A group, a friend and the browse worker have neither
  // The run's tools: its conversation's capabilities, less what attendance removes (capabilities.ts toolsFor), the same derivation for every conversation. The browse worker has its browser's own and web search.
  const tools = opts.tools ?? (browsing ? browseTools() : toolsFor(caps, kind));
  const offers = (tool: string) => browsing || tools.has(tool);
  const skills = tools.has("Skill") ? (opts.skills ?? skillsFor(caps)) : []; // (no Skill tool, no skill to load)
  const plugin = [{ type: "local" as const, path: settings.pluginDir, skipMcpDiscovery: true }];
  const tenant = browsing ? undefined : opts.tenant; // the browse worker has no tenant tools of its own
  const groupId = opts.groupId ?? opts.memory?.groupId;
  const own = opts.conversation ?? tenant?.key ?? groupId; // the conversation the run acts for: never guessed to be the owner's
  const conversation = own ?? UNSCOPED_KEY; // (keys the per-conversation state of permissions.ts)
  const tellKey = browsing ? undefined : own; // (the browse worker has none of its own)
  // Whose words the approval judge reads as the provenance of this run's calls: what the code that started it said (a look: its standing task), else the conversation's own turn when
  // someone is waiting (turnscope.ts); the browse worker: its parent's.
  const provenance = opts.provenance ?? (tellKey && kind.attended ? scopeOf(tellKey).read : undefined);
  const askedIn = tenant ? approveIn(tenant.key) : !login && groupId ? approveIn(groupId) : approve; // a tenant's browse run asks HER, in her chat
  // The MCP servers are the loaded tool modules' (src/modules): each one says whether it has a server for THIS conversation (send, voice, draw, weather: the owner's chat
  // and groups; browse: also a wake-up; memory: where there are notes; intake: a tenant with the tool; the tenant administration: the owner's chat with TENANTS=on;
  // the browser: the browse run only) and builds it (a friend's Google server process and Notion connection are answered the same way).
  const ctx: RunContext = { kind, browsing, key: tellKey, groupId, tenant, memory: opts.memory, seenMail: opts.seenMail, guard: opts.guard, mode: login ? "owner" : "group", offers, browseRun: browseRunner(askedIn, tenant, { provenance, conversation, signal, attended: kind.attended, stopScope: opts.stopScope ?? opts.sessionConv }) };
  const servers = serversFor(ctx);
  const mcpServers: Options["mcpServers"] = browsing && opts.guard
    ? servers
    : Object.keys(servers).length
      ? servers
      : undefined; // (every server a module built: a new one is never dropped here)
  // A tenant's run is on the instance key or it does not run: the owner's login is never a fallback (tenanttools.ts tenantEnv).
  // No background tasks in any run: a run ends at its first result (consume), and whatever still ran in the background (an expert the look started) died with it (delegation.ts).
  const baseEnv = { ...process.env, MCP_CONNECTION_NONBLOCKING: "false", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", ...(browsing ? { MAX_MCP_OUTPUT_TOKENS: "60000" } : {}) };
  const env = envFor(payerOf(opts), baseEnv);
  return {
    model: opts.model ?? settings.model,
    ...(opts.effort ? { effort: opts.effort } : {}),
    outputFormat: opts.outputFormat,
    // Wait for every connector before the first model call. By default they connect in the
    // background, and a slow one (seen: ~30s) means the first call runs without its tools,
    // then the tool list changes mid-session, which also throws away the prompt cache. With
    // chat's warm process (below) this wait happens before the message arrives.
    env, // (the owner's: the process environment) a browse page view is cut by code (browse.ts) well below this, so the SDK never writes one to a file the run cannot read
    // Rendered fresh on every request (not recorded once per session): the prompt carries
    // today's date and the last brief, and a change must apply to the very next message.
    // Chat uses Claude Code's preset prompt because that is where the SDK's auto-memory
    // instructions live (with a custom prompt the model says "noted" and saves nothing);
    // our persona and rules are appended. Every run of a conversation has it, a look too; only the browse worker keeps a custom prompt.
    systemPrompt: opts.memory
      ? { type: "preset", preset: "claude_code", append: opts.systemPrompt, snapshot: false }
      : { type: "custom", prompt: opts.systemPrompt, snapshot: false },
    settings: opts.memory ? { autoMemoryEnabled: true, autoMemoryDirectory: opts.memory.dir } : { autoMemoryEnabled: false },
    mcpServers,
    strictMcpConfig: !login || undefined, // nothing private is even loaded
    resume,
    persistSession: browsing ? false : undefined, // the browse worker's session is never written to ~/.claude: its tool calls can carry a card typed by code, and nothing resumes a browse run
    // Built-ins: Skill, and for chat Read / Write / Edit (confined to the notes folder by
    // policy.ts) and WebSearch / WebFetch (search freely, open a page only after approval). No Bash. Everything else the agent can do is an MCP tool (Mailbird,
    // Notion, Calendar...), gated by canUseTool.
    tools: [...builtinTools(tools), ...(delegation ? ["Agent"] : [])],
    agents: opts.experts?.setup.agents,
    // "user" loads user-scope MCP servers (Mailbird) and CLAUDE.md; the skills offered are
    // limited to the bundled ones below.
    // Not "project": there is no project here.
    settingSources: login ? ["user"] : [],
    // The bundled skills, loaded from the repo; only these are offered to the model (the owner's
    // other skills would cost context on every call and are none of its business).
    plugins: skills.length ? plugin : undefined,
    skills: skills.length ? [...skills] : undefined,
    disallowedTools: browsing ? HIDDEN_BROWSER_TOOLS : login ? hiddenTools(toolsSeen()) : undefined, // out of the model's view entirely, see policy.ts
    permissionMode: "default", // never the ambient mode (user settings or an auto mode could skip canUseTool, and with it every guard and approval)
    // (a browse run is her tenant's too, for the audit log: opts.tenant, not the `tenant` that has no tools of its own there)
    canUseTool: makeCanUseTool(approve, kind, opts.memory?.dir, undefined, opts.guard, tools, !!opts.tenant, { provenance, conversation, run, seenMail: opts.seenMail, notesSeen: () => notesSeen, browseTask: browsing ? opts.guard?.task : undefined, untrusted: opts.untrusted, restoreFree: kind.attended && login, taint: sessionTaint(opts.freshSession ? undefined : opts.sessionConv, resume), expertBriefs: delegation && (() => delegation.delegations.map((d) => d.brief)), agentTypeOf: delegation?.agentTypeOf }),
    hooks,
    maxTurns: opts.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd,
  };
}

// The stream yields many message types (system, assistant, tool use...).
// The one we want is the single "result" message that ends the turn.
export async function consume(stream: AsyncIterable<SDKMessage>, opts: RunOptions, previousCost: number): Promise<AgentReply> {
  const payer = payerOf(opts);
  let lastError: string | undefined;
  let first = false;
  let lastContext: number | undefined; // the last model call of the main loop shows how big the context is
  for await (const message of stream) {
    observe(payer, message);
    if (message.type === "system" && message.subtype === "init" && runCapabilities(opts.kind).has("login")) { // only the owner's run has connectors: its tool list says nothing about them
      recordToolsSeen(message.tools);
      recordConnectors(message.tools, message.mcp_servers);
    }
    if (message.type === "assistant") {
      if (!first && !message.parent_tool_use_id) (first = true), opts.onFirstOutput?.();
      if (message.error) lastError = message.error;
      if (!message.parent_tool_use_id) lastContext = contextTokens(message.message.usage);
    }
    if (message.type !== "result") continue;
    if (opts.sessionConv && !opts.freshSession) {
      // The first turn of a session shows what tools, skills and prompts alone cost; later turns keep that baseline (a compaction keeps it too).
      const before = readSession(opts.sessionConv);
      const baseTokens = before.sessionId === message.session_id ? before.baseTokens : lastContext; // a session from before this existed has none: the absolute limit applies until it starts fresh
      const next: ChatSession = { sessionId: message.session_id, costUsd: message.total_cost_usd, lastTurnAt: new Date().toISOString(), lastContextTokens: lastContext, ...(baseTokens !== undefined ? { baseTokens } : {}), ...(opts.seenAt ? { seenAt: opts.seenAt } : {}), ...carriedTaint(before, message.session_id) };
      writeSession(opts.sessionConv, next);
    }
    charge(payer, message.total_cost_usd - previousCost, auditSource(opts.kind)); // failures cost money too (a friend's goes to her own ledger)
    if (message.subtype === "success" && !message.is_error) {
      succeeded(payer);
      return { text: message.result, costUsd: message.total_cost_usd - previousCost, structured: message.structured_output };
    }
    throw failure(lastError, message.subtype, payer);
  }
  throw new Error("agent stream ended without a result");
}

// The one place every run passes: chat, groups, wake-ups, brief, heartbeat run, the mail handler. On the ceiling the query is aborted, the
// timeout is logged and audited, and the rejection takes the usual error path (a notice, rate-limited in groups; the queue moves on).
// A chat run (the owner's chat and groups alike) and a background run have their own limits (settings.ts).
export async function underCeiling<T>(kind: RunKind, run: (c: Ceiling) => Promise<T>, minutes?: number, scope?: string): Promise<T> {
  const source = auditSource(kind);
  try {
    return await withCeiling((minutes ?? settings.runMaxMinutesChat) * 60_000, run, scope);
  } catch (e) {
    if (e instanceof RunTimeout) {
      console.error(`run: timed out after ${e.minutes} minutes (${source})`);
      emitRecord("run", "timeout", source, { minutes: e.minutes });
    }
    throw e;
  }
}

export async function runAgent(prompt: Parameters<typeof query>[0]["prompt"], approve: Approve, opts: RunOptions, io: { query?: typeof query } = {}): Promise<AgentReply> {
  const { resume, previousCost } = opts.sessionConv && !opts.freshSession ? chatResume(opts.sessionConv) : { resume: undefined, previousCost: 0 };
  // The entry gate of an unattended run (rungate.ts; every one is a heartbeat look, a chat turn goes through agent.ts runConversation): it waits for a place, and its ceiling starts only once it has one.
  // A background run is always cold, so the approval it waits on belongs to this run and does not count against its ceiling.
  // "/stop" (ceiling.ts stopRuns) reaches a look too, also while it still waits for a place: `wait` is called off by it, by the caller's signal (a message overtook the look)
  // and, once running, by the ceiling; the gate place is released as soon as the run's promise rejects.
  const wait = new AbortController();
  const callOff = () => wait.abort(opts.signal?.reason);
  if (opts.signal?.aborted) callOff();
  opts.signal?.addEventListener("abort", callOff, { once: true });
  let started = false;
  const run = randomUUID(); // this run's id: what the journal kept for its calls is dropped when it ends
  const forget = opts.stopScope ? onStop(opts.stopScope, (e) => void (started || wait.abort(e))) : () => {};
  return gated(opts.gate ?? "chat", () => {
    started = true;
    forget(); // from here on the ceiling answers "/stop" itself
    return underCeiling(opts.kind, (c) => {
      const off = () => c.controller.abort();
      if (wait.signal.aborted) off();
      wait.signal.addEventListener("abort", off, { once: true });
      return consume((io.query ?? query)({ prompt, options: { ...buildOptions(pausing(c, ((...a: Parameters<Approve>) => parked(() => approve(...a))) as Approve), opts, resume, c.signal, run), abortController: c.controller } }), opts, previousCost).finally(() => wait.signal.removeEventListener("abort", off));
    }, opts.maxMinutes, opts.stopScope ?? opts.sessionConv);
  }, wait.signal).finally(() => (forget(), endRun(run), opts.signal?.removeEventListener("abort", callOff))).catch((e) => {
    if (opts.sessionConv && !opts.freshSession) forgetUnresumable(opts.sessionConv, e, auditSource(opts.kind));
    throw e;
  });
}
