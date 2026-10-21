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

test("a corrupt registry refuses to be saved over; repairing it makes saving work again", () => {
  T.ensureOwner({ number: "+15550000001" });
  const path = dataPath(T.REGISTRY);
  const good = readFileSync(path, "utf8");
  writeFileSync(path, "{ torn");
  const silence = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(T.listTenants(), [], "nobody is routed while it is unreadable");
    assert.throws(() => T.addTenant({ aci: ACI, name: "Eve" }), /refusing to overwrite/);
    assert.throws(() => T.ensureOwner({ number: "+15550000001" }, new Date()), /refusing to overwrite/, "start-up stops loudly rather than re-seeding the owner over it");
  } finally {
    console.error = silence;
  }
  assert.equal(readFileSync(path, "utf8"), "{ torn", "the bad file was not touched");
  assert.deepEqual(readdirSync(join(path, "..")).filter((f) => f.includes(".corrupt-")), [], "left in place, not moved: the registry is repaired by hand");
  writeFileSync(path, good);
  assert.ok(T.addTenant({ aci: ACI, name: "Eve" }), "saving works once it is readable again");
});
