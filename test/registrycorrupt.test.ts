import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An unreadable tenant registry is not an empty one: nobody is routed, and no save may replace it from defaults (its own data folder: the registry is a file).
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "registry-corrupt-"));
const T = await import("../src/tenants/tenants.ts");
const { dataPath } = await import("../src/core/state.ts");

const ACI = "11111111-2222-4333-8444-555555555555";

test("a corrupt registry pauses the friends only: the owner is still routed and start-up does not crash; nothing is saved over the file", async () => {
  T.ensureOwner({ number: "+10000000001" });
  const path = dataPath(T.REGISTRY);
  const good = readFileSync(path, "utf8");
  writeFileSync(path, "{ torn");
  const silence = console.error;
  console.error = () => {};
  try {
    const owner = T.ensureOwner({ number: "+10000000001" }); // what main.ts does at every start
    assert.equal(owner.role, "admin");
    assert.equal(T.resolveSender({ number: "+10000000001" })?.id, T.OWNER_ID, "the owner is routed from her settings");
    assert.deepEqual(T.listTenants(), [], "no friend is routed");
    assert.equal(T.tenantByAci(ACI), undefined);
    assert.equal(T.learnOwnerAci({ number: "+10000000001", aci: ACI }), false, "nothing is learned into an unreadable file");
    assert.throws(() => T.addTenant({ aci: ACI, name: "Eve" }), /refusing to overwrite/);
    assert.ok(T.registryProblem(), "the problem is reported");
    assert.match(T.REGISTRY_NOTICE, /friends are paused/);
    const lines: [boolean | string, string, string][] = [];
    const { tenantCheck } = await import("../src/doctor.ts");
    tenantCheck((ok, what, detail) => void lines.push([ok, what, detail ?? ""]) as never, { on: false });
    assert.ok(lines.some(([ok, what]) => ok === false && what === "friends list"), "npm run doctor reports it");
  } finally {
    console.error = silence;
  }
  assert.equal(readFileSync(path, "utf8"), "{ torn", "the bad file was not touched");
  assert.deepEqual(readdirSync(join(path, "..")).filter((f) => f.includes(".corrupt-")), [], "left in place, not moved: the registry is repaired by hand");
  writeFileSync(path, good);
  assert.equal(T.registryProblem(), undefined);
  assert.ok(T.addTenant({ aci: ACI, name: "Eve" }), "saving works once it is readable again");
});
