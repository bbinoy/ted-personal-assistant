import { query, type HookCallbackMatcher, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { audit, type Source } from "./audit.ts";
import { recordCost } from "./budget.ts";
import { createSendServer, OWNER_KEY } from "./send.ts";
import { createVoiceServer } from "./voicetool.ts";
import { createTenantAdminServer, createTenantServer, tenantEnv, type TenantRun } from "./tenanttools.ts";
import { browseSystem, createBrowseServer } from "./browse.ts";
import { resultText, withText, type BrowseGuard, type BrowseMode } from "./browseguard.ts";
import { browseStatus, browserServer } from "./browseserver.ts";
import { hiddenBrowserTools } from "./browserules.ts";
import { pausing, RunTimeout, withCeiling, type Ceiling } from "./ceiling.ts";
import { chatResume, forgetUnresumable } from "./chatsession.ts";
import { recordConnectors } from "./connectors.ts";
import { noteSuccess, observeRateLimit } from "./cooldown.ts";
import { failure } from "./errors.ts";
import { createMemoryServer } from "./memory-tools.ts";
import { createWeatherServer } from "./weathertools.ts";
import { createDrawServer } from "./drawtool.ts";
import { announceMemoryChanges, noteWritten, recordMemoryChange } from "./memorynotice.ts";
import { approveIn, makeCanUseTool, type Approve } from "./permissions.ts";
import { hiddenTools } from "./policy.ts";
import { OFFERED_SKILLS, PROFILES } from "./profiles.ts";
import { changesCalendar, nudgeRadar } from "./radar-nudge.ts";
import { type ChatSession } from "./session.ts";
import { settings } from "./settings.ts";
import { cleanToolOutput } from "./toolclean.ts";
import { readJson, writeJson } from "./state.ts";
import { recordToolsSeen, toolsSeen } from "./toolsseen.ts";

// The core of every agent run: its options (RunOptions, buildOptions), the stream consumer, the ceiling every run passes, runAgent, and the
// browse sub-run. The entry points that choose the options are agent.ts; the warm processes are agentwarm.ts.

export interface AgentReply {
  text: string;
  costUsd: number;
  structured?: unknown; // the run's constrained JSON output, when it asked for one
}

export interface RunOptions {
  source: Source; // audit tag: who is acting
  systemPrompt: string;
  sessionFile?: string; // chat and groups: continue + save the conversation here; brief and the rest: fresh every run
  // Turns on the SDK's auto-memory: notes in `dir`, the only place the file tools may write (policy.ts).
  // `notify` announces every change on the phone: the owner's chat only; a group's reply says what was saved.
  memory?: { dir: string; groupId?: string; notify?: (text: string) => Promise<void> };
  seenAt?: string; // groups: stored with the session, see ChatSession.seenAt
  skills?: readonly string[]; // the skills offered (default: all bundled ones, OFFERED_SKILLS)
  maxTurns: number;
  maxBudgetUsd: number; // hard per-run spend cap. Per RUN, not per session: the SDK does not count the cost a resumed session already had (checked), so owner and groups alike need no adjustment here. The previous total is subtracted only when reporting cost (consume)
  outputFormat?: Options["outputFormat"]; // constrained JSON output
  // Fires after a tool call succeeds. Used to capture the brief the agent sends.
  onToolSuccess?: (tool: string, input: unknown, response?: unknown) => void;
  onFirstOutput?: () => void; // the model's first message arrived (timing only)
  guard?: BrowseGuard; // the browse run: decides each browser call and remembers the page (browse.ts)
  maxMinutes?: number; // a wall-clock ceiling of its own (the browse run), else the chat or background one
  judgeContext?: string; // an unattended job: the instructions it was given, shown to the approval judge (autojudge.ts)
  // A tenant's run (tenants.ts): an isolated "group" run on HER OWN Anthropic API key, with her own cost ledger and cooldown. Never absent for a run
  // made for a tenant, and never given the instance's login: without a key the run does not start.
  tenant?: TenantRun;
}

// Context size of one model call: everything it was sent.
const contextTokens = (u: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

// The browse sub-run (browse.ts calls this through the entry tool): a fresh run with the browser, under the guard. A group's run is the same
// as the owner's; only `approve` differs (the group's own approver).
export function browseRunOptions(guard: BrowseGuard, tenant?: TenantRun): RunOptions {
  return {
    source: PROFILES.browse.source,
    systemPrompt: browseSystem(undefined, guard.vision, guard.profileKeys(), guard.cardInfo()),
    maxTurns: PROFILES.browse.maxTurns,
    maxBudgetUsd: PROFILES.browse.maxBudgetUsd,
    maxMinutes: settings.browseMaxMinutes,
    outputFormat: PROFILES.browse.outputSchema,
    judgeContext: guard.task,
    guard,
    tenant, // the browse worker of a tenant's run is hers too: her key, her ledger (it would otherwise be billed to the instance's login)
  };
}

// The `run` of a browse entry tool (browse.ts BrowseContext): the browse run under its guard, asking `approve` for commit steps.
export const browseRunner = (approve: Approve, tenant?: TenantRun) => (prompt: string, guard: BrowseGuard): Promise<AgentReply> => runAgent(prompt, approve, browseRunOptions(guard, tenant));

// The built-in tools of a run (everything else is an MCP tool): the browse run only searches; a group edits its own notes and searches; the
// owner's chat adds skills and opening pages; a background run has no notes; the rest only load skills.
function builtinTools(opts: RunOptions, browsing: boolean, isolated: boolean): string[] {
  if (browsing) return ["WebSearch"];
  if (opts.tenant && !opts.tenant.consented) return []; // before her age and region are confirmed her run has one tool, record_consent
  if (isolated) return ["Read", "Write", "Edit", "WebSearch"];
  if (opts.memory) return ["Skill", "Read", "Write", "Edit", "WebSearch", "WebFetch"];
  return opts.source === "background" ? ["Skill", "WebSearch", "WebFetch"] : ["Skill"];
}

export function buildOptions(approve: Approve, opts: RunOptions, resume: string | undefined): Options {
  // After a successful tool call: announce a note change on the phone (chat), and report the
  // call to whoever asked (the brief captures what it sent).
  const afterTool = async (tool: string, input: Record<string, unknown>, response?: unknown) => {
    if (opts.memory?.notify) noteWritten(tool, input);
    if (changesCalendar(tool)) nudgeRadar();
    opts.onToolSuccess?.(tool, input, response);
  };
  const hooks: Partial<Record<"PostToolUse", HookCallbackMatcher[]>> = {
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PostToolUse") return {};
            await afterTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, input.tool_response);
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
            if (!cleaned) return response === input.tool_response ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: response } };
            console.log(`clean: tool result ${input.tool_name}: ${cleaned.removed} hidden character(s) removed, ${cleaned.hidden} hidden HTML part(s) left out, ${cleaned.cut} cut`);
            return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: cleaned.output } };
          },
        ],
      },
    ],
  };

  // A group run: no connectors, no user settings, no skills; its memory server is the only MCP server.
  const browsing = opts.source === "browse"; // the browse sub-run: the browser and web search, nothing of the owner's
  const isolated = opts.source === "group" || browsing;
  // The entry tool (browse.ts) for the runs that may browse: the owner's chat, a wake-up and a group. It starts a separate browse run.
  // send (send.ts): the owner's chat and groups, never an unattended run (a wake-up included).
  const tenant = browsing ? undefined : opts.tenant; // the browse worker has no tenant tools of its own
  const tellKey = opts.source === "chat" ? OWNER_KEY : opts.source === "group" ? (tenant?.key ?? opts.memory?.groupId) : undefined;
  const mode: BrowseMode = opts.source === "group" ? "group" : "owner";
  const askedIn = tenant ? approveIn(tenant.key) : mode === "group" && opts.memory?.groupId ? approveIn(opts.memory.groupId) : approve; // a tenant's browse run asks HER, in her chat
  const browseTool =
    settings.browse && (opts.source === "chat" || opts.source === "background" || opts.source === "group") && (!tenant || tenant.consented)
      ? createBrowseServer({ mode, groupId: opts.memory?.groupId, key: tellKey, spent: tenant?.overBudget, run: browseRunner(askedIn, tenant) })
      : undefined;
  const sendServer = tellKey && (!tenant || tenant.consented) ? createSendServer(tellKey) : undefined;
  // voice (voicetool.ts): the cloned voice of this conversation, Qwen only; the owner's chat and groups, never an unattended run.
  const voiceServer = tellKey && settings.tts.provider === "qwen" && (!tenant || tenant.consented) ? createVoiceServer(tellKey) : undefined;
  // weather (weathertools.ts): read-only forecasts and spot facts from public data, for the owner's chat and for groups, never an unattended run.
  const weatherServer = (opts.source === "chat" || opts.source === "group") && settings.weather ? createWeatherServer() : undefined;
  // draw (drawtool.ts): an SVG the model writes, sanitised and rendered to a PNG it can send with `send`; the same conversations as `send`, never an unattended run.
  const drawServer = tellKey && settings.draw && (!tenant || tenant.consented) ? createDrawServer(tellKey) : undefined;
  const status = browsing ? browseStatus() : undefined;
  if (status && !status.ok) throw new Error(`browsing is not set up: ${status.reason}`);
  const mcpServers: Options["mcpServers"] = browsing && opts.guard && status?.ok
    ? { browser: browserServer(status, opts.guard.outDir, undefined, { mode: opts.guard.vision, cdpPort: opts.guard.cdpPort }) }
    : tenant && !tenant.consented
      ? { tenant: createTenantServer(tenant) }
      : opts.memory || browseTool || sendServer
        ? { ...(sendServer ? { send: sendServer } : {}), ...(weatherServer ? { weather: weatherServer } : {}), ...(drawServer ? { draw: drawServer } : {}), ...(voiceServer ? { voice: voiceServer } : {}), ...(opts.memory ? { memory: createMemoryServer({ notesDir: opts.memory.dir, groupId: opts.memory.groupId, tenantLog: tenant?.logFile, record: opts.memory.notify ? recordMemoryChange : () => {} }) } : {}), ...(browseTool ? { browse: browseTool } : {}), ...(opts.source === "chat" && settings.tenants ? { tenants: createTenantAdminServer() } : {}) } // the owner's tenant administration exists only with TENANTS=on
        : undefined;
  // A tenant's run is on the instance key or it does not run: the owner's login is never a fallback (tenanttools.ts tenantEnv).
  const baseEnv = { ...process.env, MCP_CONNECTION_NONBLOCKING: "false", ...(browsing ? { MAX_MCP_OUTPUT_TOKENS: "60000" } : {}) };
  const env = opts.tenant ? tenantEnv(baseEnv, opts.tenant.apiKey) : baseEnv;
  return {
    model: settings.model,
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
    // our persona and rules are appended. The unattended runs keep a custom prompt and
    // get their notes injected as data (notes.ts).
    systemPrompt: opts.memory
      ? { type: "preset", preset: "claude_code", append: opts.systemPrompt, snapshot: false }
      : { type: "custom", prompt: opts.systemPrompt, snapshot: false },
    settings: opts.memory ? { autoMemoryEnabled: true, autoMemoryDirectory: opts.memory.dir } : { autoMemoryEnabled: false },
    mcpServers,
    strictMcpConfig: isolated || undefined, // nothing private is even loaded
    resume,
    persistSession: browsing ? false : undefined, // the browse worker's session is never written to ~/.claude: its tool calls can carry a card typed by code, and nothing resumes a browse run
    // Built-ins: Skill, and for chat Read / Write / Edit (confined to the notes folder by
    // policy.ts) and WebSearch / WebFetch (search freely, open a page only after approval). No Bash. Everything else the agent can do is an MCP tool (Mailbird,
    // Notion, Calendar...), gated by canUseTool.
    tools: builtinTools(opts, browsing, isolated),
    // "user" loads user-scope MCP servers (Mailbird) and CLAUDE.md; the skills offered are
    // limited to the bundled ones below.
    // Not "project": there is no project here.
    settingSources: isolated ? [] : ["user"],
    // The bundled skills, loaded from the repo; only these are offered to the model (the owner's
    // other skills would cost context on every call and are none of its business).
    plugins: isolated ? undefined : [{ type: "local", path: settings.pluginDir, skipMcpDiscovery: true }],
    skills: isolated ? undefined : (opts.skills ? [...opts.skills] : OFFERED_SKILLS),
    disallowedTools: browsing ? hiddenBrowserTools(opts.guard?.vision) : isolated ? undefined : hiddenTools(toolsSeen()), // out of the model's view entirely, see policy.ts
    permissionMode: "default", // never the ambient mode (user settings or an auto mode could skip canUseTool, and with it every guard and approval)
    canUseTool: makeCanUseTool(approve, opts.source, opts.memory?.dir, opts.judgeContext, undefined, opts.guard, tenant?.tools),
    hooks,
    maxTurns: opts.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd,
  };
}

// The stream yields many message types (system, assistant, tool use...).
// The one we want is the single "result" message that ends the turn.
export async function consume(stream: AsyncIterable<SDKMessage>, opts: RunOptions, previousCost: number): Promise<AgentReply> {
  let lastError: string | undefined;
  let first = false;
  let lastContext: number | undefined; // the last model call of the main loop shows how big the context is
  for await (const message of stream) {
    observeRateLimit(message, opts.tenant?.id);
    if (message.type === "system" && message.subtype === "init" && opts.source !== "group" && opts.source !== "browse") { // a group run has no connectors: its tool list says nothing about them
      recordToolsSeen(message.tools);
      recordConnectors(message.tools, message.mcp_servers);
    }
    if (message.type === "assistant") {
      if (!first && !message.parent_tool_use_id) (first = true), opts.onFirstOutput?.();
      if (message.error) lastError = message.error;
      if (!message.parent_tool_use_id) lastContext = contextTokens(message.message.usage);
    }
    if (message.type !== "result") continue;
    if (opts.memory?.notify) announceMemoryChanges(opts.memory.notify, message.subtype === "success" ? message.result : "");
    if (opts.sessionFile) {
      // The first turn of a session shows what tools, skills and prompts alone cost; later turns keep that baseline (a compaction keeps it too).
      const before = readJson<ChatSession>(opts.sessionFile, { costUsd: 0 });
      const baseTokens = before.sessionId === message.session_id ? before.baseTokens : lastContext; // a session from before this existed has none: the absolute limit applies until it starts fresh
      const next: ChatSession = { sessionId: message.session_id, costUsd: message.total_cost_usd, lastTurnAt: new Date().toISOString(), lastContextTokens: lastContext, ...(baseTokens !== undefined ? { baseTokens } : {}), ...(opts.seenAt ? { seenAt: opts.seenAt } : {}) };
      writeJson(opts.sessionFile, next);
    }
    recordCost(message.total_cost_usd - previousCost, opts.tenant?.costFile); // failures cost money too (a tenant's goes to her own ledger)
    if (message.subtype === "success" && !message.is_error) {
      noteSuccess(opts.tenant?.id);
      return { text: message.result, costUsd: message.total_cost_usd - previousCost, structured: message.structured_output };
    }
    throw failure(lastError, message.subtype, opts.tenant?.id);
  }
  throw new Error("agent stream ended without a result");
}

// The one place every run passes: chat, groups, wake-ups, brief, radar, the mail handler. On the ceiling the query is aborted, the
// timeout is logged and audited, and the rejection takes the usual error path (a notice, rate-limited in groups; the queue moves on).
// A chat run (the owner's chat and groups alike) and a background run have their own limits (settings.ts).
export async function underCeiling<T>(source: Source, run: (c: Ceiling) => Promise<T>, minutes?: number): Promise<T> {
  const chat = source === "chat" || source === "group";
  try {
    return await withCeiling((minutes ?? (chat ? settings.runMaxMinutesChat : settings.runMaxMinutesBackground)) * 60_000, run);
  } catch (e) {
    if (e instanceof RunTimeout) {
      console.error(`run: timed out after ${e.minutes} minutes (${source})`);
      audit("run", "timeout", source, { minutes: e.minutes });
    }
    throw e;
  }
}

export async function runAgent(prompt: string, approve: Approve, opts: RunOptions, io: { query?: typeof query } = {}): Promise<AgentReply> {
  const { resume, previousCost } = opts.sessionFile ? chatResume(opts.sessionFile) : { resume: undefined, previousCost: 0 };
  // A background run is always cold, so the approval it waits on belongs to this run and does not count against its ceiling.
  return underCeiling(opts.source, (c) => consume((io.query ?? query)({ prompt, options: { ...buildOptions(pausing(c, approve), opts, resume), abortController: c.controller } }), opts, previousCost), opts.maxMinutes).catch((e) => {
    if (opts.sessionFile) forgetUnresumable(opts.sessionFile, e, opts.source);
    throw e;
  });
}
