// A mail attachment from Mailbird's get_attachment_content, as bytes. The result is a content list: a text item holding JSON ({"attachmentId", "fileName", "mimeType",
// "size", "resourceUri"}) and then the file itself: an image comes back as an `image` item (base64 `data`), any other binary as a `resource` item (base64 `blob`); capped by
// Mailbird at 10 MB. No bytes item (an error text, a file over the cap) is undefined. The claimed name and type are only a label: the bytes decide what the file is.
export function attachmentOf(content: unknown): { name?: string; bytes: Buffer } | undefined {
  if (!Array.isArray(content)) return undefined;
  let name: string | undefined;
  let b64: string | undefined;
  for (const c of content) {
    if (c?.type === "text" && typeof c.text === "string") {
      try {
        const meta = JSON.parse(c.text);
        if (typeof meta?.fileName === "string") name ??= meta.fileName;
      } catch {
        // not the metadata item
      }
    } else if (c?.type === "image" && typeof c.data === "string") b64 ??= c.data;
    else if (c?.type === "resource" && typeof c.resource?.blob === "string") b64 ??= c.resource.blob;
  }
  const bytes = b64 === undefined ? undefined : Buffer.from(b64, "base64");
  return bytes?.length ? { ...(name ? { name } : {}), bytes } : undefined;
}
