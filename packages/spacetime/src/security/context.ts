import { SenderError, type InferSchema, type ReadonlyDbView, type ReducerCtx } from 'spacetimedb/server';
import type spacetimedb from '../schema';
import type { ErrorCode } from '../../../shared/src/errors';

export type Schema = InferSchema<typeof spacetimedb>;
export type Ctx = ReducerCtx<Schema>;
export type ReadDb = ReadonlyDbView<Schema>;

/** Throws a typed, client-safe error. Never include secrets, tokens, or row contents in `detail`. */
export function fail(code: ErrorCode, detail: string): never {
  throw new SenderError(`${code}: ${detail}`);
}

export function newId(ctx: Ctx): string {
  return ctx.newUuidV7().toString();
}
