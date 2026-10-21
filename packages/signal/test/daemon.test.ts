import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSignalDaemon } from "../src/daemon.ts";
import { FakeSignalDaemon } from "../src/testing.ts";

test("daemon: a daemon that already listens is reused, and stop() leaves it alone", async () => {
  const fake = await FakeSignalDaemon.start();
  try {
    const d = await ensureSignalDaemon({ account: "+10000000000", host: fake.host, port: fake.port });
    assert.equal(d.started, false);
    d.stop();
    await new Promise((r) => setTimeout(r, 20));
    // still listening
    await new Promise<void>((resolve, reject) => net.connect(fake.port, fake.host).once("connect", function (this: net.Socket) { this.destroy(); resolve(); }).once("error", reject));
  } finally {
    await fake.close();
  }
});

test("daemon: a signal-cli that dies at start is an error, not a hang", { skip: process.platform === "win32" && "needs a shell script" }, async () => {
  // A stand-in `signal-cli` on PATH that exits at once.
  const bin = mkdtempSync(join(tmpdir(), "fake-signal-cli-"));
  writeFileSync(join(bin, "signal-cli"), "#!/bin/sh\nexit 3\n");
  chmodSync(join(bin, "signal-cli"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    await assert.rejects(ensureSignalDaemon({ account: "+10000000000", host: "127.0.0.1", port }), /exited before it opened its port/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("daemon: a host other than this machine is refused unless allowed", async () => {
  for (const host of ["0.0.0.0", "192.168.1.5", "example.com", ""]) {
    await assert.rejects(ensureSignalDaemon({ account: "+10000000000", host, port: 1 }), /refusing to run signal-cli/);
  }
  // allowed hosts get past the guard (nothing listens on port 1 of ::1/localhost, so only the later steps could fail: use a fake)
  const fake = await FakeSignalDaemon.start();
  try {
    assert.equal((await ensureSignalDaemon({ account: "+10000000000", host: "LOCALHOST", port: fake.port })).started, false);
    assert.equal((await ensureSignalDaemon({ account: "+10000000000", host: fake.host, port: fake.port, allowNonLoopback: true })).started, false);
  } finally {
    await fake.close();
  }
});

test("daemon: a log descriptor given as a function is not opened for a reused daemon, and is closed after a spawn", { skip: process.platform === "win32" && "needs a shell script" }, async () => {
  let opened = 0;
  const open = () => (opened++, openSync(join(mkdtempSync(join(tmpdir(), "daemon-log-")), "d.log"), "a"));
  const fake = await FakeSignalDaemon.start();
  try {
    await ensureSignalDaemon({ account: "+10000000000", host: fake.host, port: fake.port, logFd: open });
    assert.equal(opened, 0, "a reused daemon keeps its own file: nothing to open (or rotate)");
  } finally {
    await fake.close();
  }
  const bin = mkdtempSync(join(tmpdir(), "fake-signal-cli-"));
  writeFileSync(join(bin, "signal-cli"), "#!/bin/sh\nexit 3\n");
  chmodSync(join(bin, "signal-cli"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  let fd = -1;
  try {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    await assert.rejects(ensureSignalDaemon({ account: "+10000000000", host: "127.0.0.1", port, logFd: () => (fd = open()) }), /exited before/);
    assert.equal(opened, 1);
    assert.throws(() => fstatSync(fd), /EBADF/, "our copy of the descriptor is closed");
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});
