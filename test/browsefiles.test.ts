import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { BrowseGuard } from "../src/modules/browse/browseguard.ts";

const B = "mcp__browser__browser_";

// The browser server resolves a file name against its working directory (the repository): the guard makes every name a file directly in the run folder.
test("a file name the model passes to the browser server is confined to the run folder", async () => {
  const out = join(tmpdir(), "run-x");
  const g = new BrowseGuard({ mode: "owner", task: "order a pizza for Ann", outDir: out, resolver: async () => ["93.184.216.34"] });
  for (const tool of ["snapshot", "find"]) {
    for (const name of ["f.txt", "sub/s.md", "../../escape.md", "/etc/cron.d/x", "..\\..\\w.md", "..", ""]) {
      const d = await g.decide(`${B}${tool}`, { filename: name, ...(tool === "find" ? { pattern: "x" } : {}) });
      assert.equal(d.kind, "defer");
      const f = d.input?.filename;
      if (name === ".." || name === "") assert.equal(f, undefined, name);
      else {
        assert.equal(typeof f, "string", name);
        assert.equal(dirname(String(f)), out, name);
      }
    }
  }
  assert.equal((await g.decide(`${B}snapshot`, {})).input, undefined); // no file name: the server's own output folder applies
});
