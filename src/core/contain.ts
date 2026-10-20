import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";

// Real location of a path that may not exist yet: resolve ".." first, then follow symlinks on the
// longest existing part and append the rest.
export function realish(path: string): string {
  const rest: string[] = [];
  let p = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(p), ...rest.reverse());
    } catch {
      const parent = dirname(p);
      if (parent === p) return resolve(path);
      rest.push(p.slice(parent.length + 1));
      p = parent;
    }
  }
}

// True only for a path strictly inside dir (not dir itself), after ".." and symlinks are resolved.
export function isInside(path: unknown, dir: string): path is string {
  if (typeof path !== "string" || path === "" || path.includes("\0")) return false;
  const rel = relative(realish(dir), realish(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
