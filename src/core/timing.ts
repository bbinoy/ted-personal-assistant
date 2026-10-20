// One compact timing line per answered turn, for the owner's chat and groups alike, so a slow start can be found
// instead of guessed. Durations in ms and a conversation kind only: never message content.
//   settle    message arrived -> the settling pause is over
//   gate      the participation gate call (groups, untagged only); gateWait: how long the burst still waited for it after settling
//   gateDelay the delay the gate asked for
//   queue     waiting behind an earlier turn of the same conversation
//   typing    message arrived -> "typing..." started
//   first     message arrived -> the model's first message (not the first token: the SDK reports whole messages)
//   run       the model run itself
//   total     message arrived -> reply sent
export interface Timing {
  readonly kind: "owner" | "group" | "tenant";
  mark(name: string): void; // ms since the message arrived; the first call per name wins
  set(name: string, ms: number): void; // a duration; the first call per name wins
  report(log?: (line: string) => void): void; // logs the line once
  line(): string;
}

export function startTiming(kind: Timing["kind"], now: () => number = Date.now, arrivedAt: number = now()): Timing {
  const fields = new Map<string, number>();
  let reported = false;
  const set = (name: string, ms: number) => void (fields.has(name) || fields.set(name, Math.max(0, Math.round(ms))));
  const line = () => `timing ${kind} ${[...fields].map(([k, v]) => `${k}=${v}`).join(" ")}`;
  return {
    kind,
    mark: (name) => set(name, now() - arrivedAt),
    set,
    line,
    report: (log = console.log) => {
      if (reported) return;
      reported = true;
      log(line());
    },
  };
}
