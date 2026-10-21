import { LIMITS } from "../core/sanitize.ts";

// Full arguments, size-capped; audit() redacts secrets in the whole line.
export const argsForAudit = (input: Record<string, unknown>): unknown => {
  const json = JSON.stringify(input);
  return json.length <= LIMITS.args ? input : `${json.slice(0, LIMITS.args)}… (+${json.length - LIMITS.args} more characters)`;
};
