import { describe, expect, it, vi } from 'vitest';
import { ClientGrpc } from '@nestjs/microservices';
import { BookingService } from './booking.service';
import { BookingRepository } from '../infrastructure/booking.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';
import { BookingResolver } from '../presentation/graphql/booking.resolver';
import { BookingInternalServiceTokenGuard } from '../../../common/auth/booking-internal-service-token.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

describe('BookingService.internalTrendingSalesPage', () => {
  it('returns stable cursors and reports whether another page exists', async () => {
    const aggregateTrendingSales = vi.fn().mockResolvedValue([
      { eventId: '64b64c0000000000000000a1', confirmedQuantity: 9 },
      { eventId: '64b64c0000000000000000a2', confirmedQuantity: 8 },
    ]);
    const service = new BookingService(
      {} as ClientGrpc,
      {} as ClientGrpc,
      { aggregateTrendingSales } as unknown as BookingRepository,
      {} as OutboxProcessor,
    );

    const page = await service.internalTrendingSalesPage({
      since: new Date('2026-09-22T10:00:00.000Z'),
      first: 1,
    });

    expect(aggregateTrendingSales).toHaveBeenCalledWith({
      since: new Date('2026-09-22T10:00:00.000Z'),
      first: 2,
      after: undefined,
    });
    expect(page.nodes).toHaveLength(1);
    expect(page.nodes[0]).toMatchObject({
      eventId: '64b64c0000000000000000a1',
      confirmedQuantity: 9,
    });
    expect(page.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: page.nodes[0].cursor,
    });
  });

  it('rejects invalid dates, limits and cursors before aggregation', async () => {
    const aggregateTrendingSales = vi.fn();
    const service = new BookingService(
      {} as ClientGrpc,
      {} as ClientGrpc,
      { aggregateTrendingSales } as unknown as BookingRepository,
      {} as OutboxProcessor,
    );

    await expect(
      service.internalTrendingSalesPage({ since: new Date('invalid') }),
    ).rejects.toThrow('since must be a valid date');
    await expect(
      service.internalTrendingSalesPage({ since: new Date(), first: 201 }),
    ).rejects.toThrow('first must be between 1 and 200');
    await expect(
      service.internalTrendingSalesPage({ since: new Date(), after: 'invalid' }),
    ).rejects.toThrow('Invalid trending cursor');
    expect(aggregateTrendingSales).not.toHaveBeenCalled();
  });
});

describe('BookingResolver.internalTrendingSales', () => {
  it('requires the internal booking service token guard', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      BookingResolver.prototype,
      'internalTrendingSales',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, descriptor?.value)).toContain(
      BookingInternalServiceTokenGuard,
    );
  });
});
