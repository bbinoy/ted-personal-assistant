// A mail attachment from Mailbird's get_attachment_content, as bytes. The server's result shape is UNVERIFIED LIVE (the first run with a real attachment is the check):
// read tolerantly, a base64 string under a key like content, data or base64 (in an object, a list or the text itself), and a file name under name or fileName.
const B64 = /^[A-Za-z0-9+/\s]+={0,2}\s*$/;
const DATA_KEY = /^(content|data|base64|contentbase64|bytes)$/i;
const NAME_KEY = /^(file)?name$/i;

export function attachmentOf(res: unknown): { name?: string; bytes: Buffer } | undefined {
  let name: string | undefined;
  let data: string | undefined;
  const walk = (x: unknown, key = "", depth = 0): void => {
    if (data !== undefined || depth > 4) return;
    if (typeof x === "string") {
      if ((DATA_KEY.test(key) || (key === "" && depth === 0)) && x.length >= 8 && B64.test(x)) data = x;
    } else if (Array.isArray(x)) x.forEach((y) => walk(y, key, depth + 1));
    else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) if (typeof v === "string" && NAME_KEY.test(k)) name ??= v; // (the name may come after the content)
      for (const [k, v] of Object.entries(x)) walk(v, k, depth + 1);
    }
  };
  walk(res);
  const bytes = data === undefined ? undefined : Buffer.from(data, "base64");
  return bytes?.length ? { ...(name ? { name } : {}), bytes } : undefined;
}
