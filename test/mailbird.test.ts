import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionFrom } from "../src/modules/mailbird/mailbird.ts";

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
