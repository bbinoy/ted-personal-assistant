// The real-account guard of the end-to-end eval. The eval must never reach the owner's real services, so it fails closed at four places:
//   1. the run's MCP servers are Ted's own in-process ones plus the fakes (strict config, no user settings, claude.ai connectors off in the environment);
//   2. the SDK's start-up message is checked against that list before the first message is read: anything else (a claude.ai connector, the user's Mailbird) aborts the run;
//   3. a tool call that is not a fake's, a local tool of Ted's or a plain local built-in is refused and counted (the web, the browser, voice, drawing, weather, a mail attachment fetch);
//   4. Ted's own code talks to Mailbird directly (src/modules/mailbird/mailbird.ts, for approval read-backs and open_file): every method of that client throws and is counted, so a run in which
//      a real client was used is invalid, and the draft reader is the fake's.
import type { CanUseTool, Options, query as sdkQuery, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { normalizeServerName, toolPrefix } from "./fakeserver.ts";
import type { FakeWeb } from "./fakeweb.ts";

type WebPages = Pick<FakeWeb, "rewrite" | "certFile" | "search">;

// Ted's own servers that only touch the conversation's own files in the temp data folder. Every other own server (browse, voice, draw, weather, files, intake, tenants, google, notionhosted) reaches
// out (network, a device, the real mail client) and is refused: a case that needs one gets a fake first.
const LOCAL_SERVERS: readonly string[] = ["tasks", "memory", "people", "send", "meetings"];
// Built-in tools that stay inside the run: notes, skills, delegation, tool search. WebFetch and WebSearch are not here: they are the open internet.
const LOCAL_BUILTINS = new Set(["Read", "Write", "Edit", "Skill", "Agent", "ToolSearch", "TodoWrite", "Glob", "Grep"]);

export interface GuardState {
  violations: string[]; // un-faked or forbidden tool calls, a bad start-up message, a real client used
  initServers: { name: string; status: string }[]; // the MCP servers the SDK reported (every start-up message of the run)
  inits: number; // start-up messages seen and found clean
  realClientCalls: number; // calls to the real Mailbird client
  aborted: boolean;
}
export const newGuardState = (): GuardState => ({ violations: [], initServers: [], inits: 0, realClientCalls: 0, aborted: false });

// Pure: what is wrong with a start-up message's servers and tools, given the server names that may be there (normalized or not).
export function initProblems(init: { mcp_servers: readonly { name: string; status: string }[]; tools: readonly string[] }, allowed: readonly string[]): string[] {
  const ok = new Set(allowed.map(normalizeServerName));
  const problems = init.mcp_servers.filter((s) => !ok.has(normalizeServerName(s.name))).map((s) => `unexpected MCP server ${s.name} (${s.status})`);
  const prefixes = [...ok].map((n) => toolPrefix(n));
  for (const t of init.tools) if (t.startsWith("mcp__") && !prefixes.some((p) => t.startsWith(p))) problems.push(`unexpected MCP tool ${t}`);
  return [...new Set(problems)];
}

// Pure: is this tool call one a fake or Ted's local tools answers? (Everything else is refused.)
export function isAnswered(tool: string, fakeTools: ReadonlySet<string>): boolean {
  if (fakeTools.has(tool)) return true;
  if (tool.startsWith("mcp__")) return LOCAL_SERVERS.some((s) => tool.startsWith(toolPrefix(s)));
  return LOCAL_BUILTINS.has(tool);
}

// Wraps the run's own canUseTool: a call nobody answers is refused, counted, and ends the run.
function guardedCanUseTool(inner: CanUseTool, fakeTools: ReadonlySet<string>, state: GuardState, abort: () => void, web?: WebPages): CanUseTool {
  return async (tool, input, opts) => {
    // A page fetch: the run's own rules (the floor, the judge, the owner) decide on the address the model gave; if they allow it and the case has that page, the real tool is pointed at the fake server.
    if (tool === "WebFetch" && web) {
      const local = web.rewrite(String(input.url ?? ""));
      if (!local) {
        state.violations.push(`un-faked page fetch: ${String(input.url).slice(0, 100)}`);
        abort();
        return { behavior: "deny", message: "This page is not available in this environment." };
      }
      const r = await inner(tool, input, opts);
      return r?.behavior === "allow" ? { ...r, updatedInput: { ...(r.updatedInput ?? input), url: local } } : r;
    }
    // A web search: the built-in tool runs at the provider and cannot be pointed at a local server, so once the run's own rules allow it, the case's fake web answers in its place: the result list comes back as the
    // reply of a refused call. Nothing reaches the net.
    if (tool === "WebSearch" && web) {
      const r = await inner(tool, input, opts);
      return r?.behavior === "allow" ? { behavior: "deny", message: web.search(String(input.query ?? "")) } : r;
    }
    if (!isAnswered(tool, fakeTools)) {
      state.violations.push(`un-faked tool call: ${tool}`);
      abort();
      return { behavior: "deny", message: "This tool is not available in this environment." };
    }
    return inner(tool, input, opts);
  };
}

// Makes the run's options hermetic: only the given servers (Ted's own and the fakes), no user or project settings, no claude.ai connectors, and the guards above.
function hermetic(options: Options, fakes: Record<string, NonNullable<Options["mcpServers"]>[string]>, fakeTools: ReadonlySet<string>, state: GuardState, abort: () => void, web?: WebPages): Options {
  return {
    ...options,
    mcpServers: { ...(options.mcpServers ?? {}), ...fakes },
    strictMcpConfig: true,
    settingSources: [],
    env: { ...(options.env ?? process.env), ENABLE_CLAUDEAI_MCP_SERVERS: "false", ...(web ? { NODE_EXTRA_CA_CERTS: web.certFile } : {}) },
    canUseTool: guardedCanUseTool(options.canUseTool!, fakeTools, state, abort, web),
  };
}

// The `query` the run is given: the SDK's own, over hermetic options, with the start-up message checked as it passes. A start-up message with anything unexpected in it is never read past:
// the run is aborted at once (before the held first message is answered by a model), the problem is kept, and the stream ends with an error.
export function guardedQuery(real: typeof sdkQuery, fakes: Record<string, NonNullable<Options["mcpServers"]>[string]>, fakeTools: ReadonlySet<string>, state: GuardState, web?: WebPages): typeof sdkQuery {
  return ((args: Parameters<typeof sdkQuery>[0]) => {
    const own = Object.keys(args.options?.mcpServers ?? {});
    const allowed = [...own, ...Object.keys(fakes)]; // (all of Ted's own servers may start: those that reach out are refused when called, isAnswered)
    const controller = args.options?.abortController ?? new AbortController();
    const abort = () => {
      state.aborted = true;
      controller.abort();
    };
    const q = real({ ...args, options: { ...hermetic(args.options ?? {}, fakes, fakeTools, state, abort, web), abortController: controller } });
    const source = q[Symbol.asyncIterator].bind(q);
    return new Proxy(q, {
      get: (target, key) =>
        key === Symbol.asyncIterator
          ? () => {
              const inner = source();
              return {
                next: async () => {
                  const r = await inner.next();
                  const m = r.value as SDKMessage | undefined;
                  if (!r.done && m?.type === "system" && m.subtype === "init") {
                    state.initServers = m.mcp_servers.map((s) => ({ name: s.name, status: s.status }));
                    const problems = initProblems(m, allowed);
                    if (problems.length) {
                      state.violations.push(...problems.map((p) => `start-up: ${p}`));
                      abort();
                      throw new Error(`eval guard: ${problems.join("; ")}`);
                    }
                    state.inits++;
                  }
                  return r;
                },
                return: inner.return?.bind(inner),
                throw: inner.throw?.bind(inner),
                [Symbol.asyncIterator]() {
                  return this;
                },
              };
            }
          : Reflect.get(target, key),
    });
  }) as typeof sdkQuery;
}

// Every method of the real Mailbird client throws and is counted. The class is patched on its prototype, so any `new Mailbird()` anywhere in Ted's code (the attachment source of open_file, the approval
// read-back, the restore command) hits it. Returns the state to read at the end of the run.
export function blockRealMailbird(client: { prototype: object }, state: GuardState): void {
  for (const method of ["connect", "call", "content", "close"]) {
    Object.defineProperty(client.prototype, method, {
      configurable: true,
      value: () => {
        state.realClientCalls++;
        state.violations.push(`the real Mailbird client was used (${method})`);
        throw new Error("eval guard: the real Mailbird client is blocked");
      },
    });
  }
}

// Fail closed before any model call: the guard must be in place or the run does not start.
export function assertHermetic(env: NodeJS.ProcessEnv, dataDir: string | undefined): void {
  if (!dataDir || !/e2e/i.test(dataDir)) throw new Error("eval guard: HARNESS_DATA_DIR must be the eval's own temporary folder");
  if (env.ENABLE_CLAUDEAI_MCP_SERVERS !== "false") throw new Error("eval guard: claude.ai connectors are not switched off in the environment");
}
