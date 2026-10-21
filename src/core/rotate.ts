import { copyFileSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";

// Size-based rotation for the files that would otherwise grow for ever. `keep` generations: path.1 (newest) ... path.<keep>; the oldest is dropped.
// Never throws: a log that cannot be rotated is still a log.

function shift(path: string, keep: number): void {
  rmSync(`${path}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    try {
      renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    } catch {
      /* missing is fine */
    }
  }
}

const over = (path: string, maxBytes: number): boolean => {
  try {
    return statSync(path).size > maxBytes;
  } catch {
    return false; // no file yet
  }
};

// For a file nobody holds open (the heartbeat rows, a log about to be opened by a child): the file becomes path.1 and a new one starts at the next write.
export function rotateIfOver(path: string, maxBytes: number, keep: number): boolean {
  if (!over(path, maxBytes)) return false;
  try {
    shift(path, keep);
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

// For a file a child process holds open in APPEND mode (the signal-cli daemon's log: openLog): it cannot be renamed away from under it, so a copy goes to path.1 and the
// file is cut to nothing; the child's next write lands at the new end. A line written between the copy and the cut is lost (a log, not a ledger).
export function copyTruncateIfOver(path: string, maxBytes: number, keep: number): boolean {
  if (!over(path, maxBytes)) return false;
  try {
    shift(path, keep);
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    return true;
  } catch {
    return false;
  }
}

