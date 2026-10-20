import { test } from "node:test";
import assert from "node:assert/strict";
import { settings } from "../src/core/settings.ts";
import { runJudge } from "../src/approvals/approvaljudge.ts";
import { haikuOptions } from "../src/tenants/haiku.ts";
import { spentToday } from "../src/core/budget.ts";

// The approval judge, the reply classifier and the question writer run on JUDGE_MODEL (Sonnet by default); the other small helpers (the gate...) stay on Haiku.
(settings as { warm: boolean }).warm = false;

test("JUDGE_MODEL defaults to sonnet and is the model of every judge call, answer, write and action alike", async () => {
  assert.equal(settings.judgeModel, "sonnet");
  const seen: { model?: unknown; maxBudgetUsd?: unknown }[] = [];
  const query = (a: { options: { model?: unknown; maxBudgetUsd?: unknown } }) => {
    seen.push(a.options);
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.02, result: "", structured_output: { task: "answer", target: "none", outcome: "unrelated" } };
    })();
  };
  const before = spentToday();
  for (const task of ["answer", "write", "action"] as const) await runJudge(task, "p", { query: query as never });
  assert.deepEqual(seen.map((o) => o.model), ["sonnet", "sonnet", "sonnet"]);
  assert.ok(Number(seen[0]!.maxBudgetUsd) >= 0.1, "the per-call cap leaves room for a retry turn on the bigger model");
  assert.ok(Math.abs(spentToday() - before - 0.06) < 1e-9, "the judge's calls are counted in the day's spend like every other call");
});

test("the shared small-model base stays Haiku for everything that does not choose a model", () => {
  assert.equal(haikuOptions("s").model, "haiku");
});
