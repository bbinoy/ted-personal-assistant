import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configHcl, installBinary, intakePolicyHcl, layoutOf, OPERATOR_POLICY, PIN, policyHcl, ensureDirs } from "../src/openbaoadmin.ts";
import { ITEM_KINDS } from "../src/secrets.ts";
import { keeperPlist, serverPlist, serviceNames } from "../src/openbaoservice.ts";

// The pure parts of the setup tool: the pinned download, the config, the policies and the launchd files. (The real server is in openbao-e2e.test.ts.)

test("install: a download that does not match the pinned checksum installs nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bao-install-"));
  const l = layoutOf(dir);
  await assert.rejects(installBinary(l, { download: async () => Buffer.from("not the release") }), /pinned checksum/);
  assert.equal(existsSync(l.bin), false);
  assert.ok(existsSync(dir) && !existsSync(join(dir, "dl")), "no half-downloaded file is left");
  assert.match(PIN.sha256, /^[0-9a-f]{64}$/);
  assert.ok(PIN.url.startsWith("https://github.com/openbao/openbao/releases/download/v" + PIN.version + "/"));
});

test("layout: every folder is private to the owner", () => {
  const l = layoutOf(join(mkdtempSync(join(tmpdir(), "bao-layout-")), "openbao"));
  ensureDirs(l);
  for (const d of [l.dir, l.data, l.auditDir, l.logs, l.tlsDir, l.backups]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
});

test("config: loopback only, TLS 1.3 with the pinned certificate, Raft storage, an audit file device with mode 0600, nothing else", () => {
  const l = layoutOf("/srv/x/openbao");
  const hcl = configHcl(l, "https://127.0.0.1:8200");
  assert.match(hcl, /address\s+= "127\.0\.0\.1:8200"/);
  assert.match(hcl, /cluster_address\s+= "127\.0\.0\.1:8201"/);
  assert.ok(!/0\.0\.0\.0|\[::\]/.test(hcl));
  assert.match(hcl, /tls_min_version = "tls13"/);
  assert.match(hcl, /storage "raft"/);
  assert.match(hcl, /audit "file" "file"/);
  assert.match(hcl, /mode\s+= "0600"/);
  assert.match(hcl, /ui = false/);
  assert.match(configHcl(l, "https://127.0.0.1:18200"), /127\.0\.0\.1:18201/);
});

test("policies: the owner's token reaches tenants/owner/ and nothing else; the operator's reaches no secret", () => {
  const p = policyHcl("ted", "owner");
  const paths = [...p.matchAll(/path "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(paths, ["ted/data/tenants/owner/*", "ted/metadata/tenants/owner/*", "ted/data/tenants/+/google/*", "ted/data/tenants/+/notion/*"]); // (the last two: read of a friend's Google grant, read and write-back of her Notion grant, nothing else of hers)
  assert.match(p, /notion\/\*" \{\s*capabilities = \["read", "create", "update"\]/);
  assert.match(p, /google\/\*" \{\s*capabilities = \["read"\]/);
  assert.ok(!/sudo|"\*"|sys\//.test(p));
  const op = [...OPERATOR_POLICY.matchAll(/path "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(op, ["sys/generate-root-token/*", "sys/storage/raft/snapshot"]);
  assert.ok(!op.some((x) => x!.startsWith("ted/")));
});

test("the intake page's policy is write-only: create and update of profile, card, google and notion items of any tenant, nothing else", () => {
  const p = intakePolicyHcl("ted");
  const blocks = [...p.matchAll(/path "([^"]+)" \{\s*capabilities = \[([^\]]*)\]/g)].map((m) => [m[1], m[2]!.replace(/[" ]/g, "")]);
  assert.deepEqual(blocks, [["ted/data/tenants/+/profile/*", "create,update"], ["ted/data/tenants/+/card/*", "create,update"], ["ted/data/tenants/+/google/*", "create,update"], ["ted/data/tenants/+/notion/*", "create,update"]]);
  assert.ok(!/read|list|delete|sudo|metadata|sys\//.test(p.replace(/^#.*$/m, "")));
});

test("launchd files: filled in and escaped; the server job has a 077 umask and no secret in either", () => {
  const l = layoutOf("/srv/x/open&bao");
  const server = serverPlist(readFileSync(new URL("../launchd/openbao.plist.template", import.meta.url), "utf8"), l, "com.me.ted-openbao");
  assert.ok(server.includes("<string>/srv/x/open&amp;bao/bin/bao</string>") && server.includes("-config=/srv/x/open&amp;bao/config.hcl"));
  assert.ok(!server.includes("__"), "every placeholder is filled");
  assert.match(server, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  const keeper = keeperPlist(readFileSync(new URL("../launchd/openbao-keeper.plist.template", import.meta.url), "utf8"), l, "com.me.ted-openbao-keeper", "/srv/repo", { OPENBAO_ADDR: "https://127.0.0.1:8200", OPENBAO_MOUNT: "ted" });
  assert.ok(!keeper.includes("__") && keeper.includes("<key>OPENBAO_ADDR</key>") && keeper.includes("/srv/repo/scripts/openbao-keep.sh"));
  assert.match(keeper, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.deepEqual(serviceNames({ OPENBAO_LAUNCHD_LABEL: "com.me.x" }), { server: "com.me.x", keeper: "com.me.x-keeper" });
});

// The policies are GENERATED from secrets.ts ITEM_KINDS. These are the texts they had before that (kept literally): a change to what the tokens may do must be a decision
// made here, in the open, never a side effect of adding a kind.
test("policies: generated from the kinds, byte-identical to the hand-written texts for profile, card, google and notion", () => {
  assert.equal(policyHcl("ted", "owner"), `# The app's token for tenant "owner": its own folder and nothing else.
path "ted/data/tenants/owner/*" {
  capabilities = ["create", "read", "update", "delete"]
}
path "ted/metadata/tenants/owner/*" {
  capabilities = ["list", "read", "delete"]
}
# A friend's Google grant (the intake page writes it, the process that starts her Google server reads it): read only, nothing else of hers.
path "ted/data/tenants/+/google/*" {
  capabilities = ["read"]
}
# A friend's Notion grant: read, and create and update, because Notion's refresh tokens rotate and the new one is written back before it is used (notionoauth.ts). No delete, no list.
path "ted/data/tenants/+/notion/*" {
  capabilities = ["read", "create", "update"]
}
`);
  assert.equal(policyHcl("m", "ann-1"), `# The app's token for tenant "ann-1": its own folder and nothing else.
path "m/data/tenants/ann-1/*" {
  capabilities = ["create", "read", "update", "delete"]
}
path "m/metadata/tenants/ann-1/*" {
  capabilities = ["list", "read", "delete"]
}
# A friend's Google grant (the intake page writes it, the process that starts her Google server reads it): read only, nothing else of hers.
path "m/data/tenants/+/google/*" {
  capabilities = ["read"]
}
# A friend's Notion grant: read, and create and update, because Notion's refresh tokens rotate and the new one is written back before it is used (notionoauth.ts). No delete, no list.
path "m/data/tenants/+/notion/*" {
  capabilities = ["read", "create", "update"]
}
`);
  assert.equal(intakePolicyHcl("ted"), `# The intake page's token: write-only.
path "ted/data/tenants/+/profile/*" {
  capabilities = ["create", "update"]
}
path "ted/data/tenants/+/card/*" {
  capabilities = ["create", "update"]
}
path "ted/data/tenants/+/google/*" {
  capabilities = ["create", "update"]
}
path "ted/data/tenants/+/notion/*" {
  capabilities = ["create", "update"]
}
`);
  assert.deepEqual([...ITEM_KINDS], ["profile", "card", "google", "notion"]);
});
