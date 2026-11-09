import { sleep } from "../util/async.ts";
import type { Delivery } from "../types.ts";

const CLAIM_MARGIN_MS = 2_000;

export async function drainClaimedDeliveries(opts: {
  claim(type: string, claimMs: number): Promise<Delivery[]>;
  types: string[];
  claimMs: number;
  deliver(d: Delivery): Promise<void>;
  leaseLost?: () => boolean;
  label: string;
}): Promise<number> {
  const { types, claimMs, deliver, leaseLost, label } = opts;
  const claimMargin = Math.min(CLAIM_MARGIN_MS, Math.floor(claimMs / 3));
  const expiresAt = new Map<string, number>();

  const claim = async (): Promise<{ rows: Delivery[]; complete: boolean }> => {
    const rows: Delivery[] = [];
    let complete = true;
    for (const t of types) {
      try {
        const claimed = await opts.claim(t, claimMs);
        const at = Date.now();
        for (const r of claimed) expiresAt.set(r.id, at + claimMs);
        rows.push(...claimed);
      } catch {
        complete = false;
      }
    }
    return { rows, complete };
  };
  const t0 = Date.now();
  const queue = (await claim()).rows;
  const seen = new Set(queue.map((d) => d.id));
  const absorb = (fresh: Delivery[]): void => {
    for (const f of fresh) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        queue.push(f);
      }
    }
  };

  const reclaimOwnership = async (id: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (leaseLost?.()) return false;
      if (attempt > 0) await sleep(Math.min(300, claimMargin));
      const { rows, complete } = await claim();
      absorb(rows);
      if (rows.some((f) => f.id === id)) return true;
      if (!complete) continue;
    }
    return false;
  };
  const lostMidDrain = (): boolean => {
    if (!leaseLost?.()) return false;
    console.error(`[${label}] delivery dispatch lease lost mid-drain — stopping; rows recover after claim TTL`);
    return true;
  };
  for (let i = 0; i < queue.length; i++) {
    if (lostMidDrain()) return queue.length;
    const d = queue[i]!;
    const exp = expiresAt.get(d.id) ?? 0;
    if (Date.now() >= exp - claimMargin) {
      const remaining = exp - Date.now();
      if (remaining > 0) await sleep(remaining);
      if (!(await reclaimOwnership(d.id))) {
        seen.delete(d.id);
        console.log(
          `[${label}] delivery ${d.id} claim lost after ${Date.now() - t0}ms (another relay owns it, or it was acked) — skipping`,
        );
        continue;
      }
    }
    if (lostMidDrain()) return queue.length;
    await deliver(d);
  }
  return queue.length;
}
