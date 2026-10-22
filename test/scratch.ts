// Where a test puts a throwaway file of its own. Never a path of the real layout (core/convpaths.ts owns those): a name in instance/ or in logs/, inside the test's data folder.
import { join } from "node:path";
import { instancePaths, logPaths } from "../src/core/convpaths.ts";

export const scratch = (name: string): string => join(instancePaths().dir, name);
export const scratchLog = (name: string): string => join(logPaths().dir, name);

// A throwaway instance database of its own (same schema as instance.db) for a test that wants an empty ledger, e.g. new Ledger(scratchDb("payments-x")).
import { openInstanceDbAt } from "../src/core/instancedb.ts";
export const scratchDb = (name: string) => openInstanceDbAt(scratch(`${name}.db`));
