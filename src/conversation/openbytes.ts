import { withTempFile } from "../modules/send/shots.ts";
import { preparePicture, sniff, type Picture } from "../run/image.ts";
import { documentFromBytes, type Document } from "./document.ts";

// Bytes of a file the assistant fetched itself (a mail attachment, open_file) -> what the model is shown, by the rules of the files people send in the chat: the BYTES decide.
// A picture goes the way of image.ts (checked, shrunk, HEIC converted: it needs a file, so a short-lived private copy is made and removed), a PDF or a text file the way of
// document.ts; anything else is refused. Throws a sentence the model can be told.
export type Opened = { kind: "image"; picture: Picture; name: string } | Document;

export async function openBytes(bytes: Buffer, claimedName?: string): Promise<Opened> {
  if (!sniff(bytes)) return documentFromBytes(bytes, claimedName);
  const picture = await withTempFile({ name: "picture", bytes }, (file) => preparePicture(file));
  return { kind: "image", picture, name: claimedName ?? "picture" };
}

// Whether a held file is a picture, so it is sent as one.
export const isPicture = (bytes: Uint8Array): boolean => !!sniff(bytes);
