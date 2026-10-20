import { closeSync, ftruncateSync, openSync, readSync, fstatSync, writeSync } from "node:fs";

// launchd opens logs/launchd-stderr.log for us and keeps it open, so it cannot be renamed away like agent.log: the file is
// cut down in place instead (same file, same owner-only mode). Only the raw crash output goes there, but it grew without end.

// Pure: the last `keep` bytes, starting at a line boundary (the cut line is dropped, not left half).
export function keepTail(buf: Buffer, keep: number): Buffer {
  if (buf.length <= keep) return buf;
  const tail = buf.subarray(buf.length - keep);
  if (buf[buf.length - keep - 1] === 0x0a) return tail; // the cut fell exactly between two lines
  const nl = tail.indexOf(0x0a);
  return nl === -1 ? tail : tail.subarray(nl + 1);
}

// At start-up: if the file is over `maxBytes`, keep the last `keepBytes`. Returns the bytes dropped (0: left alone). Never throws.
export function trimLogInPlace(file: string, maxBytes: number, keepBytes: number): number {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r+");
    const size = fstatSync(fd).size;
    if (size <= maxBytes) return 0;
    const buf = Buffer.alloc(keepBytes + 1); // one byte more, to see whether the cut falls on a line start
    const got = readSync(fd, buf, 0, keepBytes + 1, size - keepBytes - 1);
    const kept = keepTail(buf.subarray(0, got), keepBytes);
    ftruncateSync(fd, 0);
    writeSync(fd, kept, 0, kept.length, 0);
    return size - kept.length;
  } catch {
    return 0; // no such file yet, or not ours to change
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
