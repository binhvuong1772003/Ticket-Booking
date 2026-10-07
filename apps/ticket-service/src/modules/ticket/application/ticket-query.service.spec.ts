import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TicketQueryService } from './ticket-query.service';

const row = (id: string, issuedAt: Date, extra = {}) => ({
  id,
  bookingId: 'booking-1',
  ordinal: 1,
  status: 'ISSUED',
  issuedAt,
  eventTitle: 'Show',
  posterImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/poster.png',
  coverImageUrl: null,
  venueName: 'Hall',
  venueAddress: null,
  startsAt: new Date('2026-10-01T10:00:00Z'),
  endsAt: null,
  timezone: 'Asia/Ho_Chi_Minh',
  ticketTypeName: 'Standard',
  ticketTypeCode: 'STD',
  unitPrice: '255000',
  currency: 'VND',
  templateVersion: 1,
  renderRevision: 1,
  credentialVersion: 1,
  ...extra,
});

describe('TicketQueryService', () => {
  const ticketId = '00000000-0000-4000-8000-000000000001';
  const setup = (findMany = vi.fn(), findFirst = vi.fn(), findUnique = vi.fn()) =>
    new TicketQueryService(
      { ticket: { findMany, findFirst, findUnique } } as any,
      { sign: vi.fn(() => 'signed-token') } as any,
    );

  it('lists only the requested owner without including QR credentials', async () => {
    const findMany = vi.fn().mockResolvedValue([row('00000000-0000-4000-8000-000000000001', new Date())]);
    const service = setup(findMany);
    const result = await service.listOwnedTickets('user-a', '', 20);
    expect(findMany.mock.calls[0][0].where.ownerId).toBe('user-a');
    expect(result.items[0]).not.toHaveProperty('qrToken');
  });

  it('uses a stable timestamp and id cursor, and rejects malformed cursors', async () => {
    const at = new Date('2026-09-28T00:00:00.000Z');
    const firstId = '00000000-0000-4000-8000-000000000002';
    const secondId = '00000000-0000-4000-8000-000000000001';
    const findMany = vi.fn().mockResolvedValue([row(firstId, at), row(secondId, at)]);
    const service = setup(findMany);
    const first = await service.listOwnedTickets('user-a', '', 1);
    expect(first.nextCursor).toBeTruthy();
    await service.listOwnedTickets('user-a', first.nextCursor!, 1);
    expect(findMany.mock.calls[1][0].where.OR).toEqual([
      { issuedAt: { lt: at } },
      { issuedAt: at, id: { lt: firstId } },
    ]);
    await expect(service.listOwnedTickets('user-a', 'bad', 20)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates page limits and hides another owner as not found', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = setup(undefined, findFirst);
    await expect(service.listOwnedTickets('user-a', '', 101)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getOwnedTicket('user-b', ticketId)).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: ticketId, ownerId: 'user-b' } });
  });

  it('returns credential only in owned detail and suppresses it for a void ticket', async () => {
    const findFirst = vi.fn().mockResolvedValue(row(ticketId, new Date()));
    const findUnique = vi.fn().mockResolvedValue(row(ticketId, new Date(), { status: 'VOIDED' }));
    const service = setup(undefined, findFirst, findUnique);
    expect((await service.getOwnedTicket('user-a', ticketId)).qrToken).toBe('signed-token');
    expect((await service.getOwnedTicket('user-a', ticketId)).posterImageUrl).toContain('poster.png');
    expect((await service.getTicketForDelivery(ticketId)).qrToken).toBeNull();
  });

  it('reports legacy rows with incomplete snapshots as preparing', async () => {
    const service = setup(undefined, vi.fn().mockResolvedValue(row(ticketId, new Date(), { unitPrice: null })));
    await expect(service.getOwnedTicket('user-a', ticketId)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
