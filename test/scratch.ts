// Where a test puts a throwaway file of its own. Never a path of the real layout (core/convpaths.ts owns those): a name in instance/ or in logs/, inside the test's data folder.
import { join } from "node:path";
import { instancePaths, logPaths } from "../src/core/convpaths.ts";

export const scratch = (name: string): string => join(instancePaths().dir, name);
export const scratchLog = (name: string): string => join(logPaths().dir, name);
