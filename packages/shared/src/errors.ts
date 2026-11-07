// Typed backend error codes. Reducer/procedure failures surface as a message of the form
// "<CODE>: <human readable detail>". Clients should branch on the code prefix only.

export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'ACCESS_DENIED',
  'INCIDENT_NOT_FOUND',
  'NOT_FOUND',
  'INVALID_TRANSITION',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ParsedBackendError {
  code: ErrorCode | 'UNKNOWN';
  detail: string;
}

export function parseBackendError(message: string): ParsedBackendError {
  const match = /(?:^|\s)([A-Z_]+): (.*)$/s.exec(message);
  if (match && (ERROR_CODES as readonly string[]).includes(match[1])) {
    return { code: match[1] as ErrorCode, detail: match[2] };
  }
  return { code: 'UNKNOWN', detail: message };
}
