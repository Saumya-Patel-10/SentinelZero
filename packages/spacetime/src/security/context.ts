import { SenderError, type InferSchema, type ReadonlyDbView, type ReducerCtx } from 'spacetimedb/server';
import { Uuid } from 'spacetimedb';
import type spacetimedb from '../schema';
import type { ErrorCode } from '../../../shared/src/errors';

export type Schema = InferSchema<typeof spacetimedb>;
export type Ctx = ReducerCtx<Schema>;
export type ReadDb = ReadonlyDbView<Schema>;

/** Throws a typed, client-safe error. Never include secrets, tokens, or row contents in `detail`. */
export function fail(code: ErrorCode, detail: string): never {
  throw new SenderError(`${code}: ${detail}`);
}

const ID_SEQUENCE = 'id';
const COUNTER_MASK = 0x7fffffffn;
/** Odd multiplier: a bijection on 31 bits, so ids do not expose a plain global counter. */
const COUNTER_SCRAMBLE = 0x5bd1e995n;

/**
 * UUIDv7 whose 31-bit counter field comes from a persisted sequence.
 *
 * ctx.newUuidV7() seeds its RNG from ctx.timestamp alone and restarts its counter in every
 * transaction, so two transactions that share a timestamp generate identical ids and the second
 * insert aborts with a unique-constraint panic. The sequence makes ids unique by construction.
 */
export function newId(ctx: Ctx): string {
  const row = ctx.db.idSequence.name.find(ID_SEQUENCE);
  const value = (row?.value ?? 0n) + 1n;
  if (row) ctx.db.idSequence.name.update({ name: ID_SEQUENCE, value });
  else ctx.db.idSequence.insert({ name: ID_SEQUENCE, value });
  const counter = { value: Number((value * COUNTER_SCRAMBLE) & COUNTER_MASK) };
  return Uuid.fromCounterV7(counter, ctx.timestamp, ctx.random.fill(new Uint8Array(4))).toString();
}
