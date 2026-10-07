import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { EventSessionsFilterInput } from './event-sessions-filter.input';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const metadata = {
  type: 'body' as const,
  metatype: EventSessionsFilterInput,
};

describe('EventSessionsFilterInput validation', () => {
  it('accepts catalog location and legacy filters', async () => {
    const filter = {
      city: 'San Francisco',
      countryCode: 'US',
      placeId: 'US-CA',
    };
    await expect(pipe.transform(filter, metadata)).resolves.toMatchObject(filter);
  });

  it('accepts explicit null for optional location fields', async () => {
    await expect(
      pipe.transform({ countryCode: null, placeId: null }, metadata),
    ).resolves.toMatchObject({ countryCode: null, placeId: null });
  });

  it('rejects malformed country, place ID type, and unknown fields', async () => {
    for (const filter of [
      { countryCode: 'USA' },
      { placeId: 123 },
      { unknown: true },
    ]) {
      await expect(pipe.transform(filter, metadata)).rejects.toMatchObject({
        status: 400,
      });
    }
  });
});
