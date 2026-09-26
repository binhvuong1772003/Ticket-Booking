import { isISO8601 } from 'class-validator';

export function parseSalesStartAt(raw: unknown): Date | null {
  if (raw == null) return null;
  if (
    typeof raw !== 'string' ||
    !isISO8601(raw, { strict: true, strictSeparator: true }) ||
    !/(Z|[+-]\d{2}:\d{2})$/.test(raw) ||
    !Number.isFinite(Date.parse(raw))
  ) {
    throw new Error(
      'Invalid salesStartAt: expected an ISO timestamp with timezone',
    );
  }
  return new Date(raw);
}

export function parseSalesScheduleVersion(
  raw: unknown,
  minimum: number,
): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum) {
    throw new Error('Invalid salesScheduleVersion');
  }
  return raw;
}
