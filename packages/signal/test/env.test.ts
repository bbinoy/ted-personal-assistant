import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSignalDaemon } from "../src/daemon.ts";
import { withoutSecrets } from "../src/internal/exec.ts";

test("helper processes get no credentials: keys, tokens, secrets, passwords and agent sockets are dropped, the rest is kept", () => {
  const env = withoutSecrets({ PATH: "/bin", HOME: "/h", LANG: "C", ANTHROPIC_API_KEY: "a", CLAUDE_CODE_OAUTH_TOKEN: "b", ELEVENLABS_API_KEY: "c", TTS_HTTP_TOKEN: "d", AWS_SECRET_ACCESS_KEY: "e", DB_PASSWORD: "f", SSH_AUTH_SOCK: "/s", HF_TOKEN: "g" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
});

test("daemon: signal-cli is started without the app's credentials", { skip: process.platform === "win32" && "needs a shell script" }, async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-signal-cli-"));
  const seen = join(bin, "env.txt");
  writeFileSync(join(bin, "signal-cli"), `#!/bin/sh\nenv > "${seen}"\nexit 3\n`);
  chmodSync(join(bin, "signal-cli"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.FAKE_APP_TOKEN = "must-not-leak";
  try {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    await assert.rejects(ensureSignalDaemon({ account: "+10000000000", host: "127.0.0.1", port }), /exited before it opened its port/);
    const dumped = readFileSync(seen, "utf8");
    assert.ok(!dumped.includes("must-not-leak"), "the credential reached signal-cli");
    assert.match(dumped, /^PATH=/m, "the rest of the environment is kept");
  } finally {
    process.env.PATH = oldPath;
    delete process.env.FAKE_APP_TOKEN;
    rmSync(bin, { recursive: true, force: true });
  }
});
