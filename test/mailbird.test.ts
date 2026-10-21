import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionFrom, Mailbird, type Session } from "../src/modules/mailbird/mailbird.ts";

// A fake Mailbird session: `script` says what each call does in turn (a value, or an Error to throw).
function fakeOpen(script: (Error | string)[]) {
  const log = { opened: 0, closed: 0, calls: 0 };
  const open = async (): Promise<Session> => {
    log.opened++;
    return {
      callTool: async () => {
        const step = script[log.calls++];
        if (step instanceof Error) throw step;
        return { content: [{ type: "text", text: step ?? "{}" }] };
      },
      close: async () => void log.closed++,
    };
  };
  return { open, log };
}

test("mailbird: a dead connection is dropped, reconnected and the call retried once", async () => {
  const { open, log } = fakeOpen(["{\"a\":1}", new Error("socket hang up"), "{\"a\":2}"]);
  const mb = new Mailbird(open);
  assert.deepEqual(await mb.call("get_message"), { a: 1 });
  assert.deepEqual(await mb.call("get_message"), { a: 2 }, "Mailbird restarted between the calls: the same client object serves the second one on a new connection");
  assert.equal(log.opened, 2);
  assert.equal(log.closed, 1, "the dead one was closed");
});

test("mailbird: a second failure is the caller's, a timeout is never repeated, and the next call starts clean", async () => {
  const twice = fakeOpen([new Error("ECONNRESET"), new Error("ECONNRESET"), "ok"]);
  const a = new Mailbird(twice.open);
  await assert.rejects(a.call("x"), /ECONNRESET/);
  assert.equal(twice.log.calls, 2, "one retry, not more");
  assert.equal(await a.call("x"), "ok", "the failed client was forgotten, a new one is made");
  const slow = fakeOpen([new Error("Request timed out"), "ok"]);
  const b = new Mailbird(slow.open);
  await assert.rejects(b.call("send_message_now"), /timed out/);
  assert.equal(slow.log.calls, 1, "a call that may have run is not run again");
  assert.equal(await b.call("get_message"), "ok");
  assert.equal(slow.log.opened, 2);
});

test("mailbird: a tool's own error is not a transport failure (no retry, the client stays)", async () => {
  const log = { opened: 0 };
  const mb = new Mailbird(async () => (log.opened++, { callTool: async () => ({ isError: true, content: [{ type: "text", text: "no such message" }] }), close: async () => {} }));
  await assert.rejects(mb.call("get_message"), /get_message failed: no such message/);
  await assert.rejects(mb.call("get_message"), /no such message/);
  assert.equal(log.opened, 1);
});

test("mailbird: connecting gives up after the timeout, and a late connection is closed", async () => {
  let closed = 0;
  const mb = new Mailbird(() => new Promise<Session>((ok) => setTimeout(() => ok({ callTool: async () => ({}), close: async () => void closed++ }), 60)), 15);
  await assert.rejects(mb.connect(), /connect timed out after 15 ms/);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(closed, 1);
});

const args = (url: string) => ["-y", "mcp-remote", url, "--header", "Authorization: Bearer abc", "--transport", "http-only"];

test("mailbird: the connection (which skips certificate checks and sends a bearer token) is made only to the loopback address", () => {
  for (const url of ["https://127.0.0.1:62345/mcp", "http://127.0.0.1:8080/mcp", "https://localhost:9000/mcp", "https://[::1]:9000/mcp"]) {
    assert.deepEqual(connectionFrom({ args: args(url) }), { url, headerName: "Authorization", headerValue: "Bearer abc" });
  }
  // same first characters, another machine
  for (const url of ["https://127.0.0.1.example.com/mcp", "https://127.0.0.1@evil.example.com/mcp", "https://user:pw@127.0.0.1/mcp", "https://localhost.example.com/mcp", "ftp://127.0.0.1/mcp", "not a url"]) {
    assert.throws(() => connectionFrom({ args: args(url) }), /mailbird MCP entry not found/, url);
  }
  assert.throws(() => connectionFrom(undefined), /not found/);
  assert.throws(() => connectionFrom({ args: "https://127.0.0.1/mcp" }), /not found/);
});
