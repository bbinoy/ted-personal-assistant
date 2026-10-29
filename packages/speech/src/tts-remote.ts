import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, SAFE_INPUT, toolEnv } from "./internal/exec.ts";
import { voiceEncoding, type VoiceFormat } from "./voiceformat.ts";

// Shared parts of the optional remote speech providers (tts-elevenlabs.ts, tts-http.ts): a bounded HTTPS
// request, a check that what came back is audio, and the same ffmpeg step to the voice format as the local voice (AAC by default).
// The text sent is only the words to be spoken; keys and tokens come from the caller's config and are never logged.

const MAX_REMOTE_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4096; // all an error message ever shows is 160 characters

export type Fetch = typeof fetch;
export type AudioKind = "wav" | "mp3" | "ogg";

/** Pure: whether a remote speech endpoint is acceptable: https, or http on this machine (for testing). */
export const isSafeUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
};

// Audio format from the first bytes, else from the content type. Pure. Undefined: not audio we know. The bytes win because the
// format found here is forced on ffmpeg below: what the server calls its answer must not pick what ffmpeg parses.
export function sniffAudio(contentType: string | null, bytes: Uint8Array): AudioKind | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "mp3";
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (/^audio\/(wav|x-wav|wave|vnd\.wave)$/.test(ct)) return "wav";
  if (/^audio\/(mpeg|mp3)$/.test(ct)) return "mp3";
  if (/^audio\/(ogg|opus)$/.test(ct) || ct === "application/ogg") return "ogg";
  return undefined;
}

// The body, but never more than `max` bytes: a server that sends no Content-Length (or lies about it) cannot make us hold an
// unbounded answer in memory. Returns undefined as soon as the limit is passed.
async function readLimited(res: Response, max: number): Promise<Uint8Array | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// A short, safe description of a failed request: status and a bit of the body, with the secrets blanked out.
// 401/403 mean a wrong key; 402/429 a quota or rate limit; the reason is in the message either way.
function describe(status: number, body: string, secrets: string[]): string {
  let text = body.replace(/\s+/g, " ").slice(0, 160);
  for (const s of secrets) if (s) text = text.split(s).join("***");
  const why = status === 401 || status === 403 ? " (key or token refused)" : status === 402 || status === 429 ? " (quota or rate limit)" : "";
  return `HTTP ${status}${why}${text ? `: ${text}` : ""}`;
}

export interface RemoteRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  secrets: string[]; // blanked out of any error message
  timeoutMs: number;
  fetchImpl?: Fetch;
  format?: VoiceFormat; // the voice message format to encode to (default m4a)
  signal?: AbortSignal; // the caller's overall deadline: aborting ends the request and kills ffmpeg
}

// POSTs the request, checks the answer is audio, and returns it as a voice message (AAC in an .m4a unless `format` says otherwise) in a fresh temp folder
// (the caller deletes that folder, like for the local voice). Any timeout, HTTP error or non-audio answer throws.
export async function synthesizeRemote(req: RemoteRequest, name: string): Promise<string> {
  const failed = (e: unknown) => {
    if (req.signal?.aborted) return req.signal.reason as Error; // the caller's deadline, not a failure of the server
    const x = e as { name?: string };
    return new Error(`${name} request failed: ${x.name === "TimeoutError" || x.name === "AbortError" ? `timeout after ${Math.round(req.timeoutMs / 1000)} s` : "network error"}`);
  };
  let res: Response;
  try {
    res = await (req.fetchImpl ?? fetch)(req.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...req.headers },
      body: JSON.stringify(req.body),
      redirect: "error", // a redirect could carry the token to another host
      signal: req.signal ? AbortSignal.any([AbortSignal.timeout(req.timeoutMs), req.signal]) : AbortSignal.timeout(req.timeoutMs),
    });
  } catch (e) {
    throw failed(e);
  }
  if (!res.ok) {
    const head = await readLimited(res, MAX_ERROR_BODY_BYTES).catch(() => undefined);
    throw new Error(`${name} ${describe(res.status, head ? new TextDecoder().decode(head) : "", req.secrets)}`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_REMOTE_AUDIO_BYTES) throw new Error(`${name} answer too large (${declared} bytes)`);
  const bytes = await readLimited(res, MAX_REMOTE_AUDIO_BYTES).catch((e) => { throw failed(e); }); // the timeout also covers reading the body
  if (!bytes) throw new Error(`${name} answer is larger than ${MAX_REMOTE_AUDIO_BYTES} bytes`);
  if (bytes.length === 0) throw new Error(`${name} answer has ${bytes.length} bytes`);
  const kind = sniffAudio(res.headers.get("content-type"), bytes);
  if (!kind) throw new Error(`${name} answer is not wav, mp3 or ogg audio (content type ${res.headers.get("content-type") ?? "none"})`);
  const dir = await mkdtemp(join(tmpdir(), "speech-"));
  const raw = join(dir, `remote.${kind}`);
  const enc = voiceEncoding(req.format);
  const out = join(dir, enc.file);
  await writeFile(raw, bytes, { mode: 0o600 });
  const env = toolEnv();
  try {
    await runTool("ffmpeg", ["-v", "error", "-y", ...SAFE_INPUT, "-f", kind, "-i", raw, ...enc.args, out], { timeoutMs: 60_000, env, signal: req.signal });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true }); // nothing is left behind for a reply that is not sent
    if (req.signal?.aborted) throw req.signal.reason;
    throw new Error(`ffmpeg failed: ${((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").slice(-3).join(" | ").slice(0, 200)}`);
  }
  return out;
}
