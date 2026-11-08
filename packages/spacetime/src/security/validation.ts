import { fail } from './context';
import { IDEMPOTENCY_KEY_PATTERN, LIMITS, SHA256_HEX } from '../../../shared/src/limits';

type Bounds = { readonly min: number; readonly max: number };

// Allows tab/newline/CR; rejects other C0 controls, DEL, and bidi override characters.
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

export function text(field: string, value: string, bounds: Bounds): string {
  if (typeof value !== 'string') fail('VALIDATION_FAILED', `${field} must be a string`);
  if (value.length < bounds.min || value.length > bounds.max) {
    fail('VALIDATION_FAILED', `${field} length must be between ${bounds.min} and ${bounds.max}`);
  }
  if (FORBIDDEN_CHARS.test(value)) fail('VALIDATION_FAILED', `${field} contains forbidden control characters`);
  if (bounds.min > 0 && value.trim().length === 0) fail('VALIDATION_FAILED', `${field} must not be blank`);
  return value;
}

export function oneOf<T extends readonly string[]>(field: string, values: T, value: string): T[number] {
  if (!(values as readonly string[]).includes(value)) {
    fail('VALIDATION_FAILED', `${field} must be one of ${values.join(', ')}`);
  }
  return value as T[number];
}

export function idempotencyKey(field: string, value: string): string {
  text(field, value, LIMITS.IDEMPOTENCY_KEY);
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) fail('VALIDATION_FAILED', `${field} has invalid characters`);
  return value;
}

export function sha256Hex(field: string, value: string): string {
  if (!SHA256_HEX.test(value)) fail('VALIDATION_FAILED', `${field} must be a lowercase hex SHA-256 digest`);
  return value;
}

export function stringList(field: string, values: string[], item: Bounds): string[] {
  if (values.length > LIMITS.MAX_LIST_ITEMS) fail('VALIDATION_FAILED', `${field} has too many items`);
  values.forEach((v, i) => text(`${field}[${i}]`, v, item));
  return values;
}

/** A CLOSED incident and all its children are read-only until a COMMANDER reopens it. */
export function requireOpenIncident(status: string): void {
  if (status === 'CLOSED') fail('INVALID_TRANSITION', 'closed incidents are read-only; reopen first');
}

export function expectVersion(entity: string, actual: number, expected: number): void {
  if (actual !== expected) fail('VERSION_CONFLICT', `${entity} version is ${actual}, expected ${expected}`);
}
