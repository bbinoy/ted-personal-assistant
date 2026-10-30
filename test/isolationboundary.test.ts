import { test } from "node:test";
import assert from "node:assert/strict";
import { boundaryChecks, buildWorld, type Check } from "./isolationboundary.ts";

// The isolation boundary of a group and of a tenant, with no model (isolationboundary.ts). `npm run check:isolation` runs the same checks and then
// a live-model smoke run.
const world = await buildWorld();
const failures = (checks: Check[]) => checks.filter((c) => !c.ok).map((c) => c.name);

test("isolation boundary: a group's, a tenant's and a friend-sponsored group's options, gate and memory server hold", async () => {
  const checks = await boundaryChecks(world);
  assert.ok(checks.length > 100, `${checks.length} checks`);
  assert.deepEqual(failures(checks), []);
  assert.ok(checks.some((c) => c.name.includes("search_logs finds her own history")), "the control ran");
});

test("isolation boundary: the checker catches a gate that lets a forbidden path through", async () => {
  // a gate that allows every Read, as an SDK auto-allow or a policy hole would
  const leaky = await boundaryChecks(world, { gate: (_s, real) => async (tool, input, ctx) => (tool === "Read" ? { behavior: "allow", updatedInput: input } : real(tool, input, ctx)) });
  const failed = failures(leaky);
  assert.ok(failed.includes("tenant: canUseTool denies Read Bea's note"), failed.join("\n"));
  assert.ok(failed.includes("group: canUseTool denies Read the owner's note"));
  assert.ok(failed.includes("group: canUseTool denies Read a symlink out of her folder"));
  assert.ok(failed.includes("friendGroup: canUseTool denies Read Ann's own chat note"), "a friend's group may not read her private chat");
  assert.ok(!failed.some((n) => /Write|Edit|Bash/.test(n)), "only the Read rows fail");
  // a gate that allows one path only: the one check for it fails
  const one = await boundaryChecks(world, { gate: (_s, real) => async (tool, input, ctx) => ((input as { file_path?: string }).file_path === world.ownerAudit && tool === "Write" ? { behavior: "allow", updatedInput: input } : real(tool, input, ctx)) });
  assert.deepEqual(failures(one), ["group: canUseTool denies Write the owner's audit log", "tenant: canUseTool denies Write the owner's audit log", "friendGroup: canUseTool denies Write the owner's audit log"]);
  // a gate that denies everything fails the control
  const shut = await boundaryChecks(world, { gate: () => async () => ({ behavior: "deny", message: "no" }) });
  assert.ok(failures(shut).some((n) => /allows Write of a file in her own folder/.test(n)));
});
