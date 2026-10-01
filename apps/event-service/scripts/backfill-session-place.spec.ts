import { describe, expect, it, vi } from 'vitest';
import { backfillSessionPlaces, type BackfillPrisma } from './backfill-session-place';

const sessions = [
  { id: 'vn-1', city: 'TP.HCM', countryCode: 'VN', status: 'SCHEDULED', event: { status: 'PUBLISHED' } },
  { id: 'vn-2', city: 'Hồ Chí Minh', countryCode: 'VN', placeId: null, status: 'SCHEDULED', event: { status: 'PUBLISHED' } },
  { id: 'vn-ambiguous', city: 'Not In Catalog', countryCode: 'VN', status: 'SCHEDULED', event: { status: 'PUBLISHED' } },
  { id: 'vn-empty', city: null, countryCode: 'VN', status: 'DRAFT', event: { status: 'PUBLISHED' } },
  { id: 'us', city: 'San Francisco', countryCode: 'US', status: 'SCHEDULED', event: { status: 'PUBLISHED' } },
  { id: 'unsupported', city: 'Toronto', countryCode: 'CA', status: 'SCHEDULED', event: { status: 'PUBLISHED' } },
  { id: 'lowercase-vn', city: 'Hà Nội', countryCode: 'vn', status: 'SCHEDULED', event: { status: 'PUBLISHED' } },
  { id: 'online', city: null, countryCode: null, status: 'SCHEDULED', event: { status: 'DRAFT' } },
  { id: 'already-mapped', city: 'Boston', countryCode: 'US', placeId: 'US-MA', status: 'SCHEDULED', event: { status: 'PUBLISHED' } },
];

function createFakePrisma(input: typeof sessions = sessions): BackfillPrisma & { writes: ReturnType<typeof vi.fn> } {
  const records = structuredClone(input) as (typeof sessions[number] & { placeId?: string | null })[];
  const writes = vi.fn(async ({ where, data }: any) => {
    const record = records.find((item) => item.id === where.id);
    if (!record || record.countryCode !== where.countryCode || record.city !== where.city || record.placeId != null) return { count: 0 };
    record.placeId = data.placeId;
    return { count: 1 };
  });
  const findMany = vi.fn(async () => structuredClone(records) as any);
  return { eventSession: { findMany, updateMany: writes }, writes } as BackfillPrisma & { writes: ReturnType<typeof vi.fn> };
}

describe('backfillSessionPlaces', () => {
  it('dry-runs without writes and reports projected public counts and review IDs', async () => {
    const prisma = createFakePrisma();
    const report = await backfillSessionPlaces(prisma);

    expect(prisma.writes).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      dryRun: true,
      mapped: 2,
      ambiguous: 0,
      unsupportedCountry: 2,
      missingLocation: 2,
      manualReview: 2,
      publicSessionsBefore: 7,
      publicSessionsAfter: 7,
      unnormalizedPublicSessionsBefore: { VN: 4, US: 1 },
      unnormalizedPublicSessionsAfter: { VN: 2, US: 1 },
      reviewIds: {
        ambiguous: [],
        unsupportedCountry: ['unsupported', 'lowercase-vn'],
        missingLocation: ['vn-empty', 'online'],
        manualReview: ['vn-ambiguous', 'us'],
      },
    });
  });

  it('applies only absent VN placeIds and a second run makes no more writes', async () => {
    const prisma = createFakePrisma();
    const first = await backfillSessionPlaces(prisma, { apply: true });
    const writesAfterFirstRun = prisma.writes.mock.calls.length;
    const second = await backfillSessionPlaces(prisma, { apply: true });

    expect(first.mapped).toBe(2);
    expect(first.publicSessionsAfter).toBe(first.publicSessionsBefore);
    expect(prisma.writes).toHaveBeenCalledTimes(writesAfterFirstRun);
    expect(prisma.writes.mock.calls.map(([args]) => args.where.id)).toEqual(['vn-1', 'vn-2']);
    expect(second.mapped).toBe(0);
    expect(second.unnormalizedPublicSessionsAfter).toEqual(first.unnormalizedPublicSessionsAfter);
    expect(prisma.writes.mock.calls.map(([args]) => args.where.OR)).toEqual([
      [{ placeId: null }, { placeId: { isSet: false } }],
      [{ placeId: null }, { placeId: { isSet: false } }],
    ]);
  });

  it('never maps explicit Other labels to an Other ID', async () => {
    const prisma = createFakePrisma([
      { id: 'vn-other', city: 'Khác', countryCode: 'VN', status: 'SCHEDULED', event: { status: 'PUBLISHED' } },
      { id: 'vn-other-en', city: 'Other', countryCode: 'VN', status: 'SCHEDULED', event: { status: 'PUBLISHED' } },
    ]);

    const report = await backfillSessionPlaces(prisma);

    expect(report.mapped).toBe(0);
    expect(report.manualReview).toBe(2);
    expect(report.reviewIds.manualReview).toEqual(['vn-other', 'vn-other-en']);
    expect(prisma.writes).not.toHaveBeenCalled();
  });
});
