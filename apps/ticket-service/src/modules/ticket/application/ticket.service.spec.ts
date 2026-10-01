import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketService } from './ticket.service';
import { TicketRepository } from '../infrastructure/ticket.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';
import { BookingSnapshotClient } from '../infrastructure/booking-snapshot.client';

describe('TicketService.issueForBooking', () => {
  const issueMany = vi.fn();
  const wake = vi.fn();
  const getTicketSnapshot = vi.fn();
  const getTicketItemSnapshot = vi.fn();
  let service: TicketService;

  beforeEach(() => {
    issueMany.mockReset().mockResolvedValue({ issued: [{}, {}] });
    wake.mockReset();
    getTicketSnapshot.mockReset().mockResolvedValue({
      eventTitle: 'Saigon Live',
      eventStatus: 'PUBLISHED',
      posterImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/poster.png',
      coverImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/event.png',
      venueName: 'Phu Tho Stadium',
      venueAddress: 'Ho Chi Minh City',
      startsAt: new Date('2026-10-10T12:00:00.000Z'),
      endsAt: new Date('2026-10-10T15:00:00.000Z'),
      timezone: 'Asia/Ho_Chi_Minh',
      sessionVersion: 4,
      sessionStatus: 'SCHEDULED',
    });
    getTicketItemSnapshot.mockReset().mockResolvedValue({
      unitPriceMinor: '800000',
      unitPrice: '8000',
      currency: 'VND',
    });
    service = new TicketService(
      { issueMany } as unknown as TicketRepository,
      { wake } as unknown as OutboxProcessor,
      { getTicketSnapshot } as never,
      { getTicketItemSnapshot } as unknown as BookingSnapshotClient,
    );
  });

  it('creates quantity tickets per item with ordinals 1..N', async () => {
    await service.issueForBooking({
      booking_id: 'bk1',
      user_id: 'u1',
      event_id: 'ev1',
      session_id: 'ss1',
      items: [
        {
          booking_item_id: 'bi1',
          ticket_type_id: 'tt1',
          ticket_type_name: 'VIP',
          ticket_type_code: 'VIP',
          quantity: 2,
        },
      ],
    });

    expect(issueMany).toHaveBeenCalledTimes(1);
    const rows = issueMany.mock.calls[0][0] as {
      bookingItemId: string;
      ordinal: number;
      ownerId: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2]);
    expect(rows[0].bookingItemId).toBe('bi1');
    expect(rows[0].ownerId).toBe('u1');
    expect(wake).toHaveBeenCalled();
  });

  it('rejects a malformed booking event instead of acknowledging partial issuance', async () => {
    await expect(service.issueForBooking({ booking_id: 'bk1' })).rejects.toThrow();
    await expect(service.issueForBooking({
      booking_id: 'bk1',
      user_id: 'u1',
      event_id: 'ev1',
      session_id: 'ss1',
      items: [
        { booking_item_id: 'bi1', ticket_type_id: 'tt1', quantity: 1 },
        { booking_item_id: 'bi2', quantity: 0 },
      ],
    })).rejects.toThrow();
    expect(issueMany).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it('loads locked price and currency for a legacy booking event', async () => {
    await service.issueForBooking({
      booking_id: 'bk1', user_id: 'u1', event_id: 'ev1', session_id: 'ss1',
      items: [{ booking_item_id: 'bi1', ticket_type_id: 'tt1', quantity: 1 }],
    });

    expect(getTicketItemSnapshot).toHaveBeenCalledWith('bi1');
    expect(String(issueMany.mock.calls[0][0][0].unitPrice)).toBe('800000');
    expect(issueMany.mock.calls[0][0][0].currency).toBe('VND');
  });

  it('does not issue a legacy ticket when its locked booking snapshot is unavailable', async () => {
    getTicketItemSnapshot.mockRejectedValueOnce(new Error('booking-service unavailable'));

    await expect(service.issueForBooking({
      booking_id: 'bk1', user_id: 'u1', event_id: 'ev1', session_id: 'ss1',
      items: [{ booking_item_id: 'bi1', ticket_type_id: 'tt1', quantity: 1 }],
    })).rejects.toThrow('booking-service unavailable');

    expect(issueMany).not.toHaveBeenCalled();
  });

  it('does not wake outbox on full duplicate replay', async () => {
    issueMany.mockResolvedValue({ issued: [] });
    await service.issueForBooking({
      booking_id: 'bk1',
      user_id: 'u1',
      event_id: 'ev1',
      session_id: 'ss1',
      items: [{ booking_item_id: 'bi1', ticket_type_id: 'tt1', quantity: 1 }],
    });
    expect(issueMany).toHaveBeenCalledTimes(1);
    expect(wake).not.toHaveBeenCalled();
  });

  it('persists the locked booking price and event/session snapshot on every ticket', async () => {
    await service.issueForBooking({
      booking_id: 'bk1',
      user_id: 'u1',
      event_id: 'ev1',
      session_id: 'ss1',
      currency: 'VND',
      items: [
        {
          booking_item_id: 'bi1',
          ticket_type_id: 'tt1',
          ticket_type_name: 'VIP',
          ticket_type_code: 'VIP',
          unit_price_minor: '800000',
          quantity: 2,
        },
      ],
    });

    expect(getTicketSnapshot).toHaveBeenCalledWith('ev1', 'ss1');
    const rows = issueMany.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(String(rows[0].unitPrice)).toBe('800000');
    expect(rows[0]).toMatchObject({
      currency: 'VND',
      eventTitle: 'Saigon Live',
      posterImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/poster.png',
      coverImageUrl:
        'https://res.cloudinary.com/ticketgo/image/upload/event.png',
      venueName: 'Phu Tho Stadium',
      venueAddress: 'Ho Chi Minh City',
      startsAt: new Date('2026-10-10T12:00:00.000Z'),
      endsAt: new Date('2026-10-10T15:00:00.000Z'),
      timezone: 'Asia/Ho_Chi_Minh',
      sessionVersion: 4,
      templateVersion: 2,
      renderRevision: 1,
      status: 'ISSUED',
    });
  });

  it('does not issue tickets when authoritative event metadata is unavailable', async () => {
    getTicketSnapshot.mockRejectedValueOnce(new Error('event-service unavailable'));

    await expect(
      service.issueForBooking({
        booking_id: 'bk1',
        user_id: 'u1',
        event_id: 'ev1',
        session_id: 'ss1',
        currency: 'VND',
        items: [
          {
            booking_item_id: 'bi1',
            ticket_type_id: 'tt1',
            unit_price_minor: '800000',
            quantity: 1,
          },
        ],
      }),
    ).rejects.toThrow('event-service unavailable');

    expect(issueMany).not.toHaveBeenCalled();
  });

  it('creates already-void tickets when a confirmed booking arrives after event cancellation', async () => {
    getTicketSnapshot.mockResolvedValueOnce({
      eventTitle: 'Saigon Live', eventStatus: 'CANCELLED', coverImageUrl: null,
      venueName: null, venueAddress: null, startsAt: new Date(), endsAt: null,
      timezone: 'Asia/Ho_Chi_Minh', sessionVersion: 5, sessionStatus: 'CANCELLED',
    });
    await service.issueForBooking({
      booking_id: 'bk1', user_id: 'u1', event_id: 'ev1', session_id: 'ss1', currency: 'VND',
      items: [{ booking_item_id: 'bi1', ticket_type_id: 'tt1', unit_price_minor: '0', quantity: 1 }],
    });
    expect(issueMany.mock.calls[0][0][0]).toMatchObject({ status: 'VOIDED', voidReason: expect.any(String) });
  });
});
