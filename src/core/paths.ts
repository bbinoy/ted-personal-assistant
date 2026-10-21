import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The one place that knows where the repo sits on disk. Every other file asks here instead of
// computing "../../" from its own import.meta.url, so moving a file into a folder cannot silently
// change a path (a data dir that quietly became src/ would hide behind tests that set HARNESS_DATA_DIR).
// This is the only file that locates itself: it lives at src/core/paths.ts, so the repo root is two levels up.
// If this file ever moves, change PATHS_DEPTH and test/paths.test.ts will tell you it was missed.
const PATHS_DEPTH = 2;
let root = dirname(fileURLToPath(import.meta.url));
for (let i = 0; i < PATHS_DEPTH; i++) root = dirname(root);

export const ROOT = root;
export const PLUGIN_DIR = join(ROOT, "plugin");
export const ASSETS_DIR = join(ROOT, "assets");
export const VOICES_DIR = join(ASSETS_DIR, "voices");
export const ASSISTANTS_DIR = join(ROOT, "assistants");

// The data root (instance/, conversations/, logs/): HARNESS_DATA_DIR when set (tests do), else the repo root.
export const dataDirOf = (env: Record<string, string | undefined>): string => (env.HARNESS_DATA_DIR ? resolve(env.HARNESS_DATA_DIR) : ROOT);
