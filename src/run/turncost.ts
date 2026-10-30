// What ONE query cost. The SDK's result carries `total_cost_usd` and `modelUsage[model].costUSD`, both CUMULATIVE for the session: a resumed or forked
// session continues from the total its transcript saved, so the first result already holds the earlier turns, and a restart, compaction or lost
// stored total makes "total minus the stored total" negative or the whole history. So the delta is trusted only when it is plausible; otherwise the
// turn's cost is estimated from its own token usage, priced at the SDK's own effective rate per model (cumulative cost / cumulative weighted tokens).
// Whatever the figure, a turn never costs a negative amount or more than the run's budget cap (which the SDK enforces per query).

interface Usage { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
type ModelTotals = Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;

// Relative list prices (input = 1); only the proportions matter, the absolute rate comes from the SDK's own cost.
const weight = (i = 0, o = 0, r = 0, w = 0) => i + 5 * o + 0.1 * r + 1.25 * w;

// Collects the token usage of one query's assistant messages per model; a message split into several blocks repeats its id and usage, counted once.
export class QueryUsage {
  private seen = new Set<string>();
  private perModel = new Map<string, number>();
  add(m: { id?: string; model?: string; usage?: Usage }): void {
    if (!m.usage || !m.model || (m.id && this.seen.has(m.id))) return;
    if (m.id) this.seen.add(m.id);
    const u = m.usage;
    this.perModel.set(m.model, (this.perModel.get(m.model) ?? 0) + weight(u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0));
  }
  // The cost of these calls: each model's cumulative cost times this query's share of its cumulative weighted tokens.
  estimate(totals: ModelTotals | undefined): number {
    let usd = 0;
    for (const [model, mine] of this.perModel) {
      const t = totals?.[model];
      const all = t ? weight(t.inputTokens, t.outputTokens, t.cacheReadInputTokens, t.cacheCreationInputTokens) : 0;
      if (t?.costUSD && all > 0) usd += t.costUSD * Math.min(1, mine / all);
    }
    return usd;
  }
}

export interface TurnCost { usd: number; capped: boolean; raw: number }

// `delta` is total minus the stored total. In range it is the answer; out of range the usage estimate is, else the total clamped to [0, cap].
export function turnCost(total: number, previous: number, cap: number, usage?: QueryUsage, totals?: ModelTotals): TurnCost {
  const ok = (x: number) => Number.isFinite(x) && x >= 0 && x <= cap;
  const delta = total - previous;
  if (ok(delta)) return { usd: delta, capped: false, raw: delta };
  const estimate = usage?.estimate(totals) ?? 0;
  const usd = ok(estimate) && estimate > 0 ? estimate : Math.min(Math.max(Number.isFinite(total) ? total : 0, 0), cap);
  return { usd, capped: true, raw: delta };
}
