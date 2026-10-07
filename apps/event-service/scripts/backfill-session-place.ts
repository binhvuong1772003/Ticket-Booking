import { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPlaceByAlias, getPlace, PLACES } from '../src/modules/events/application/location-catalog';

type SessionRow = {
  id: string;
  city: string | null;
  countryCode: string | null;
  placeId: string | null;
  status: string;
  event: { status: string };
};

export interface BackfillPrisma {
  eventSession: {
    findMany(args: object): Promise<SessionRow[]>;
    updateMany(args: object): Promise<{ count: number }>;
  };
}

type ReviewBucket = 'ambiguous' | 'unsupportedCountry' | 'missingLocation' | 'manualReview';

export interface BackfillReport {
  dryRun: boolean;
  mapped: number;
  ambiguous: number;
  unsupportedCountry: number;
  missingLocation: number;
  manualReview: number;
  reviewIds: Record<ReviewBucket, string[]>;
  publicSessionsBefore: number;
  publicSessionsAfter: number;
  unnormalizedPublicSessionsBefore: { VN: number; US: number };
  unnormalizedPublicSessionsAfter: { VN: number; US: number };
}

function normalizeName(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, ' ').trim();
}

function classifyVnCity(city: string): { placeId?: string; bucket?: ReviewBucket } {
  const alias = normalizeName(city);
  const matches = PLACES.filter(
    (place) => place.countryCode === 'VN' && place.id !== 'VN-OTHER' && [place.name, place.code, ...place.aliases].some((value) => normalizeName(value) === alias),
  );
  if (matches.length > 1) return { bucket: 'ambiguous' };
  if (matches.length === 1) return { placeId: findPlaceByAlias('VN', city)?.id };
  return { bucket: 'manualReview' };
}

function isPublic(row: SessionRow): boolean {
  return row.event.status === 'PUBLISHED' && row.status !== 'DRAFT';
}

function hasValidPlace(row: SessionRow): boolean {
  return Boolean(row.placeId && getPlace(row.placeId)?.countryCode === row.countryCode?.toUpperCase());
}

function countSessions(rows: SessionRow[]) {
  const publicRows = rows.filter(isPublic);
  return {
    public: publicRows.length,
    unnormalized: {
      VN: publicRows.filter((row) => row.countryCode?.toUpperCase() === 'VN' && !hasValidPlace(row)).length,
      US: publicRows.filter((row) => row.countryCode?.toUpperCase() === 'US' && !hasValidPlace(row)).length,
    },
  };
}

/** Dry-run by default. Writes require the same VN country/city and an absent placeId. */
export async function backfillSessionPlaces(
  prisma: BackfillPrisma,
  options: { apply?: boolean } = {},
): Promise<BackfillReport> {
  const dryRun = options.apply !== true;
  const select = { id: true, city: true, countryCode: true, placeId: true, status: true, event: { select: { status: true } } };
  const rows = await prisma.eventSession.findMany({ select });
  const before = countSessions(rows);
  const reviewIds: BackfillReport['reviewIds'] = { ambiguous: [], unsupportedCountry: [], missingLocation: [], manualReview: [] };
  let mapped = 0;
  const projected = rows.map((row) => ({ ...row }));

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.placeId != null) continue;
    const country = row.countryCode?.trim();
    let placeId: string | undefined;
    if (!country) {
      reviewIds.missingLocation.push(row.id);
    } else if (country !== 'VN' && country !== 'US') {
      reviewIds.unsupportedCountry.push(row.id);
    } else if (country === 'US') {
      reviewIds.manualReview.push(row.id);
    } else if (!row.city?.trim()) {
      reviewIds.missingLocation.push(row.id);
    } else {
      const result = classifyVnCity(row.city);
      placeId = result.placeId;
      if (result.bucket) reviewIds[result.bucket].push(row.id);
    }
    if (!placeId) continue;

    if (dryRun) {
      mapped++;
      projected[index].placeId = placeId;
      continue;
    }
    const updated = await prisma.eventSession.updateMany({
      where: {
        id: row.id,
        countryCode: row.countryCode,
        city: row.city,
        OR: [{ placeId: null }, { placeId: { isSet: false } }],
      },
      data: { placeId },
    });
    mapped += updated.count;
  }

  const afterRows = dryRun ? projected : await prisma.eventSession.findMany({ select });
  const after = countSessions(afterRows);
  return {
    dryRun,
    mapped,
    ambiguous: reviewIds.ambiguous.length,
    unsupportedCountry: reviewIds.unsupportedCountry.length,
    missingLocation: reviewIds.missingLocation.length,
    manualReview: reviewIds.manualReview.length,
    reviewIds,
    publicSessionsBefore: before.public,
    publicSessionsAfter: after.public,
    unnormalizedPublicSessionsBefore: before.unnormalized,
    unnormalizedPublicSessionsAfter: after.unnormalized,
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const report = await backfillSessionPlaces(prisma as unknown as BackfillPrisma, {
      apply: process.argv.includes('--apply'),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
