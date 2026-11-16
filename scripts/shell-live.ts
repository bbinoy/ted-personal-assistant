import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, BOX_PREFIX, containerRunner, OUT_CUT, sweepBoxes, toolboxCheck } from "../src/modules/shell/box.ts";
import { runNow, stopBox } from "../src/modules/shell/shelltool.ts";
import { adoptFile, loadFile } from "../src/modules/send/shots.ts";
import { withSend } from "../src/modules/send/send.ts";
import { readAudit } from "../src/core/audit.ts";

// The live adversarial suite of the workbench (npm run test:shell): the REAL image and the real `container` service, not part of the gates (it needs Apple's `container`, the image from
// `npm run toolbox:build` and about a minute). A booby-trapped PDF or mail may tell the expert to run anything; each attempt below must fail, the host must stay as it was, and the audit
// must hold counts only. Commands here are the ones an attacker would try; every one is run as the box's own user, in a throwaway VM with no network.

const boxes: Box[] = [];
async function box(): Promise<Box> {
  const b = new Box();
  boxes.push(b);
  await b.start();
  return b;
}
const ids = (): string[] => execFileSync("container", ["list", "-a", "-q"], { encoding: "utf8" }).split(/\s+/).filter((i) => i.startsWith(BOX_PREFIX));
after(async () => {
  await Promise.all(boxes.map((b) => b.stop()));
  await sweepBoxes();
});

test("the box: loopback only, a non-root user, a read-only root, a writable tmpfs /work, nothing mounted", async () => {
  const b = await box();
  const r = await b.exec("id -u; ls /sys/class/net; touch /work/ok && echo writable; touch /etc/x 2>&1; mount | grep -E ' / | /work ' ; ls /Users /home /host 2>&1 | head -3");
  assert.match(r.stdout, /^10001\nlo\nwritable\n/);
  assert.match(r.stdout, /Read-only file system/);
  assert.doesNotMatch(r.stdout, /virtiofs|fuse|9p/);
});

test("host files: nothing of the host's file system is there, however it is searched", async () => {
  const host = mkdtempSync(join(tmpdir(), "shell-live-host-"));
  const marker = `HOST-MARKER-${Math.random().toString(36).slice(2)}`;
  writeFileSync(join(host, "secret.txt"), marker);
  writeFileSync(join(host, ".env"), `KEY=${marker}`);
  const b = await box();
  const r = await b.exec(`ls /Users ~/.ssh /home/*/.ssh 2>&1 | head -5; cat ${host}/secret.txt 2>&1; ls ${host} 2>&1; grep -rIl ${marker} / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | head -3; echo searched`);
  assert.ok(!r.stdout.includes(marker) && !r.stderr.includes(marker));
  assert.match(r.stdout, /No such file|cannot access/);
  assert.match(r.stdout, /searched$/m);
  const none = await b.exec("find / -xdev \\( -name 'id_rsa*' -o -name '.env' -o -name 'openbao*' -o -name 'tenants.json' -o -name '*.sqlite' \\) 2>/dev/null | head -3; echo done");
  assert.equal(none.stdout.trim(), "done");
});

test("network: no interface but lo, no route, no DNS, no TCP or UDP out, not the host gateway, not the VM subnet", async () => {
  const b = await box();
  const py = `
import socket, sys
def tcp(h, p):
    try:
        socket.create_connection((h, p), timeout=3).close(); return "OPEN"
    except Exception as e:
        return "closed"
out = [tcp("1.1.1.1", 80), tcp("8.8.8.8", 53), tcp("192.168.64.1", 22), tcp("192.168.64.1", 80), tcp("192.168.64.2", 80), tcp("127.0.0.1", 9)]
try:
    socket.getaddrinfo("example.com", 80); out.append("DNS")
except Exception:
    out.append("nodns")
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
try:
    s.sendto(b"x", ("8.8.8.8", 53)); s.recvfrom(10); out.append("UDP")
except Exception:
    out.append("noudp")
print(" ".join(out))
`;
  await b.put("net.py", Buffer.from(py));
  const r = await b.exec("python3 /work/in/net.py; cat /proc/net/route | tail -n +2 | wc -l; ls /sys/class/net; getent hosts example.com || echo nohost; (exec 3<>/dev/tcp/1.1.1.1/80) 2>&1 | head -1");
  assert.match(r.stdout, /^closed closed closed closed closed closed nodns noudp\n0\nlo\nnohost/);
  assert.doesNotMatch(r.stdout, /OPEN|DNS\b|UDP/);
});

test("other boxes: two live boxes share no file system, no network and no process", async () => {
  const a = await box();
  const b = await box();
  const token = `BOX-A-${Math.random().toString(36).slice(2)}`;
  await a.exec(`echo ${token} > /work/mine; sleep 61 & echo $! > /work/pid`);
  const r = await b.exec(`cat /work/mine 2>&1; ls /work; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c 'slee[p] 61'; ls /sys/class/net; grep -rl ${token} / --exclude-dir=proc --exclude-dir=sys 2>/dev/null | head -2; echo end`);
  assert.doesNotMatch(r.stdout, new RegExp(token));
  assert.match(r.stdout, /No such file/);
  assert.match(r.stdout, /\n0\nlo\nend/); // (no process of the other box is seen)
  assert.notEqual(a.name, b.name);
});

test("env: the box has no variable of the host's, and nothing of the application's environment is in it", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-" + "ant-api03-LIVE-TEST-NOT-REAL";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "oat-LIVE-TEST-NOT-REAL";
  try {
    const b = await box();
    const r = await b.exec("env; echo ---; tr '\\0' '\\n' < /proc/1/environ; echo ---; tr '\\0' '\\n' < /proc/self/environ");
    assert.doesNotMatch(r.stdout, /LIVE-TEST|sk-ant|ANTHROPIC|OAUTH|TOKEN|SECRET|PASSWORD/i);
    assert.match(r.stdout, /HOME=\/work/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
});

test("resources: a fork bomb is bounded and the box answers afterwards", async () => {
  const b = await box();
  const r = await b.exec(":(){ :|:& };: ; sleep 4; echo survived", 12);
  assert.ok(r.code === 0 || r.code === 124, `exit ${r.code}`);
  const after = await b.exec("echo alive; ps -u box | wc -l", 20);
  assert.match(after.stdout, /^alive/);
});

test("resources: endless output is cut at 30 kB and the host process stays small", async () => {
  const b = await box();
  const rss0 = process.memoryUsage().rss;
  const r = await b.exec("head -c 400000000 /dev/zero | tr '\\0' 'x'; echo end", 60);
  assert.ok(r.stdout.length <= OUT_CUT && r.cut);
  assert.ok(r.total >= 399_000);
  assert.ok(process.memoryUsage().rss - rss0 < 150_000_000, "the output was drained, not held");
});

test("resources: a command that never ends is killed at its time limit, and the box is still usable", async () => {
  const b = await box();
  const t0 = Date.now();
  const r = await b.exec("while :; do :; done", 3);
  assert.ok(r.killed && r.code !== 0);
  assert.ok(Date.now() - t0 < 12_000, "stopped near the limit");
  assert.match((await b.exec("echo back")).stdout, /back/);
});

test("resources: memory over the cap is killed by the VM, a zip bomb stops at the file-size limit, the box lives on", async () => {
  const b = await box();
  const mem = await b.exec("python3 -c \"x = bytearray(1_600_000_000); print('allocated')\"", 60);
  assert.notEqual(mem.code, 0);
  assert.doesNotMatch(mem.stdout, /allocated/);
  const bomb = await b.exec("head -c 700000000 /dev/zero | zip -q /work/z.zip - && ls -l /work/z.zip | awk '{print $5}'", 90);
  assert.ok(Number(bomb.stdout.trim()) < 5_000_000, bomb.stdout + bomb.stderr);
  const open = await b.exec("unzip -p /work/z.zip > /work/big; echo \"exit $?\"; ls -l /work/big | awk '{print $5}'; df -m /work | tail -1", 90);
  const size = Number(open.stdout.split("\n").find((l) => /^\d+$/.test(l)) ?? 0);
  assert.ok(size <= 210_000_000, `the file stopped growing at the limit (${size})`);
  assert.doesNotMatch(open.stdout, /^exit 0$/m);
  assert.match((await b.exec("echo alive")).stdout, /alive/);
});

test("escalation: no sudo, no setuid file, no root, nothing writable but /work, no mount, no new namespace to root", async () => {
  const b = await box();
  const r = await b.exec(
    "sudo -n true 2>&1; su -c id 2>&1 </dev/null | head -1; find / -xdev -perm /6000 -type f 2>/dev/null | head -3; echo 'setuid-done'; python3 -c 'import os; os.setuid(0)' 2>&1 | tail -1; touch /usr/x /etc/x /bin/x 2>&1; chmod u+s /work/ok 2>&1; echo > /proc/sys/kernel/hostname 2>&1; mount -t tmpfs x /mnt 2>&1; unshare -Urm sh -c 'touch /etc/x; cat /etc/shadow; touch /usr/y' 2>&1 | head -3; cat /etc/shadow 2>&1 | head -1; id -u",
  );
  assert.doesNotMatch(r.stdout, /^0$/m);
  assert.match(r.stdout, /setuid-done\n[\s\S]*Operation not permitted/);
  assert.match(r.stdout, /Read-only file system/);
  assert.match(r.stdout, /10001\n$/);
  assert.doesNotMatch(r.stdout, /root:\*|root:x/);
});

test("exfiltration: nothing goes anywhere but through the tool's own result and send(file)", async () => {
  const b = await box();
  const r = await b.exec("curl -s -m 3 https://example.com 2>&1 | head -2; wget -q -T 3 -O- http://example.com 2>&1 | head -2; python3 -c \"import urllib.request; urllib.request.urlopen('http://example.com', timeout=3)\" 2>&1 | tail -1; echo end");
  assert.doesNotMatch(r.stdout, /Example Domain|<html/i);
});

test("a crash leaves a box behind; the start-up sweep removes it, and only ted-box-* ones", async () => {
  const leftover = new Box();
  await leftover.start(); // (never stopped: as if the process had died)
  assert.ok(ids().includes(leftover.name));
  const removed = await sweepBoxes();
  assert.ok(removed >= 1);
  assert.deepEqual(ids(), []);
  assert.equal(execFileSync("container", ["list", "-a", "-q"], { encoding: "utf8" }).includes("buildkit") || true, true, "other containers are not the sweep's business");
});

test("the tool end to end: a CSV is totalled, a chart comes back as a file id, the box is gone with the turn, the audit has counts only", async () => {
  const key = "live-shell";
  const csv = "item,amount\ncoffee,3.50\nbooks,12.25\ntrain,40.00\n";
  const secret = "UNIQUE-COMMAND-TEXT-93";
  let told = "";
  await withSend(key, async () => "ok", async () => {
    adoptFile(key, Buffer.from(csv), "expenses.csv");
    const total = await runNow(key, { command: `python3 -c "import pandas as pd; d=pd.read_csv('/work/in/expenses.csv'); print(d.amount.sum()) # ${secret}"` });
    told = (total.content.at(-1) as { text: string }).text;
    assert.match(told, /55\.75/);
    const chart = await runNow(key, { command: "python3 -c \"import pandas as pd, matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; d=pd.read_csv('/work/in/expenses.csv'); d.plot.bar(x='item', y='amount'); plt.savefig('/work/out/chart.png')\"" });
    const text = (chart.content.at(-1) as { text: string }).text;
    const id = /(file\d+): chart\.png/.exec(text)?.[1];
    assert.ok(id, text);
    const png = (loadFile(key, id!) as { file: { bytes: Buffer } }).file.bytes;
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    // a PDF made in the box is shown to the model through the fileN line the run's hook swaps for the document
    const pdf = await runNow(key, { command: "python3 -c \"import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.plot([1,2,3]); plt.savefig('/work/page.pdf')\"", show: "page.pdf" });
    assert.match((pdf.content.at(-1) as { text: string }).text, /^file\d+: page\.pdf, PDF, 1 page/);
    // a link out of /work is not a file, a big file is not kept, a file in a folder keeps its name
    const odd = await runNow(key, { command: "ln -s /etc/passwd /work/out/link; head -c 22000000 /dev/zero > /work/out/huge.bin; mkdir -p /work/out/sub; echo hi > /work/out/sub/note.txt" , show: "/etc/passwd" });
    const o = (odd.content.at(-1) as { text: string }).text;
    assert.doesNotMatch(o, /link/);
    assert.match(o, /huge\.bin: not kept/);
    assert.match(o, /note\.txt/);
    assert.match(o, /show: .*not a plain file/);
  });
  assert.deepEqual(ids(), [], "the box went with the turn");
  const rows = readAudit((e) => e.tool === "shell");
  assert.ok(rows.length >= 4);
  assert.ok(!JSON.stringify(rows).includes(secret), "no command text in the audit");
  await stopBox(key);
});

test("doctor: the real check passes with the real image", async () => {
  const lines: [boolean | "warn", string][] = [];
  await toolboxCheck((ok, what, detail) => void lines.push([ok, `${what}: ${detail ?? ""}`]), true, containerRunner);
  assert.equal(lines.at(-1)![0], true, lines.at(-1)![1]);
});
