// npm run gates: the six checks that must pass before a merge or push (CONTRIBUTING.md). They are independent (they read the source and write
// only to temp folders, and lint and knip install into their own tools/ folders), so they run at once; output is buffered and shown only for a
// check that failed. One gates run at a time per machine (scripts/gates-lock.ts). The non-test checks run at lower priority so the tests,
// which already run their files in parallel, get most of the CPU.
// `npm run gates:quick -- <test files...>` (agents iterating): typecheck + lint + the given test files + the cross-cutting tests that assert
// fixtures, prompts, run options, folder boundaries and the policy/approval tables. Same lock, same runner. Full `npm run gates` is the pre-push gate.
import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { acquire } from "./gates-lock.ts";

const quick = process.argv[2] === "--quick";
const alwaysRun = [
  "runinputs", "runoptions", "runidentity", "default-prompts", "promptcaps", "promptsunified", "preset", "manifestrows",
  "boundaries", "docs-layout", "policy", "approvals", "approvalsafety", "approvalflow", "isolationboundary",
].map((n) => `test/${n}.test.ts`);
const testFiles = [...new Set([...process.argv.slice(3), ...alwaysRun])];
const testCmd = ["node", "--conditions=workspace-source", "--import", "./test/setup.ts", "--test", ...testFiles];

const all: { name: string; cmd: string[]; nice: boolean }[] = [
  { name: "typecheck", cmd: ["npx", "tsc", "--noEmit", "--noUnusedLocals"], nice: true },
  { name: "lint", cmd: ["npm", "run", "--silent", "lint"], nice: true },
  { name: "test", cmd: quick ? testCmd : ["npm", "run", "--silent", "test"], nice: false },
  { name: "secrets", cmd: ["npm", "run", "--silent", "check:secrets"], nice: true },
  { name: "isolation", cmd: ["npm", "run", "--silent", "check:isolation"], nice: true },
  { name: "unused", cmd: ["npm", "run", "--silent", "check:unused"], nice: true },
];

const checks = quick ? all.filter((c) => ["typecheck", "lint", "test"].includes(c.name)) : all;

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
await acquire({ onWait: (h) => console.log(`waiting for another gates run (pid ${h?.pid}, started ${h ? hhmm(h.started) : "?"})`) });

const results = await Promise.all(
  checks.map(
    (c) =>
      new Promise<{ name: string; ok: boolean; secs: number; out: string }>((resolve) => {
        const t0 = Date.now();
        const p = spawn(c.cmd[0]!, c.cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
        if (c.nice && p.pid) {
          try {
            setPriority(p.pid, 10);
          } catch {
            /* best effort */
          }
        }
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        const done = (ok: boolean) => resolve({ name: c.name, ok, secs: (Date.now() - t0) / 1000, out });
        p.on("error", (e) => {
          out += String(e);
          done(false);
        });
        p.on("close", (code) => done(code === 0));
      }),
  ),
);

for (const r of results.filter((r) => !r.ok)) console.log(`\n===== ${r.name} output =====\n${r.out.trimEnd()}\n`);
for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${r.name.padEnd(10)} ${r.secs.toFixed(1)}s`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
