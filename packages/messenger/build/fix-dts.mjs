// tsc rewrites ".ts" import paths to ".js" in the emitted JavaScript but leaves them in the .d.ts files. A declaration
// file should name the .js file next to it (what every TypeScript version understands), so rewrite them here.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".d.ts")) yield p;
  }
}

for (const file of walk("dist")) {
  const text = readFileSync(file, "utf8");
  const fixed = text.replace(/(from\s+|import\()(["'])(\.{1,2}\/[^"']*)\.ts\2/g, "$1$2$3.js$2");
  if (fixed !== text) writeFileSync(file, fixed);
}
