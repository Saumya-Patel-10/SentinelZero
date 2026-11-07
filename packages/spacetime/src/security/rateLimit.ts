import { fail, type Ctx } from './context';
import { RATE_LIMITS } from '../../../shared/src/limits';

/** Fixed-window per-identity limiter. Throws RATE_LIMITED when the window budget is spent. */
export function consumeRateLimit(ctx: Ctx, action: keyof typeof RATE_LIMITS): void {
  const { windowSeconds, max } = RATE_LIMITS[action];
  const key = `${action}:${ctx.sender.toHexString()}`;
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const windowMicros = BigInt(windowSeconds) * 1_000_000n;
  const row = ctx.db.rateLimit.key.find(key);
  if (!row || now - row.windowStartMicros >= windowMicros) {
    if (row) ctx.db.rateLimit.key.update({ key, windowStartMicros: now, count: 1 });
    else ctx.db.rateLimit.insert({ key, windowStartMicros: now, count: 1 });
    return;
  }
  if (row.count >= max) fail('RATE_LIMITED', `too many ${action} calls; retry later`);
  ctx.db.rateLimit.key.update({ ...row, count: row.count + 1 });
}
