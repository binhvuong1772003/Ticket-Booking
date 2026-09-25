import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { NotFoundException } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingRepository } from '../infrastructure/booking.repository';
import { CreateBookingInput } from '../presentation/graphql/inputs/create-booking.input';

const input = (
  overrides: Partial<CreateBookingInput> = {},
): CreateBookingInput =>
  ({
    eventId: 'evt1',
    sessionId: 'sess1',
    ticketTypeId: 'tt1',
    quantity: 2,
    ...overrides,
  }) as CreateBookingInput;

const booking = { id: 'bk1', status: 'PENDING' };

const snapshot = {
  success: true,
  reservation_id: 'res-1',
  message: '',
  ticket_type_name: 'VIP',
  ticket_type_code: 'VIP',
  unit_price: 2550,
  currency: 'USD',
};

describe('BookingService.create', () => {
  let service: BookingService;
  const createPending = vi.fn();
  const cancel = vi.fn();
  const reserve = vi.fn();
  const release = vi.fn();
  const createCheckout = vi.fn();

  const clientGrpcOf = (service: object) => ({
    getService: vi.fn().mockReturnValue(service),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    createPending.mockResolvedValue(booking);
    reserve.mockReturnValue(of(snapshot));
    release.mockReturnValue(of({ success: true, message: '' }));
    createCheckout.mockReturnValue(
      of({
        success: true,
        checkout_session_id: 'cs_1',
        client_secret: 'sec_1',
        message: '',
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        {
          provide: 'INVENTORY_GRPC',
          useValue: clientGrpcOf({ reserve, release }),
        },
        {
          provide: 'PAYMENT_GRPC',
          useValue: clientGrpcOf({ createCheckout }),
        },
        {
          provide: BookingRepository,
          useValue: { createPending, cancel },
        },
      ],
    }).compile();

    service = module.get(BookingService);
    service.onModuleInit();
  });

  it('creates booking from the inventory snapshot, not client input', async () => {
    await service.create(input(), 'user-1');

    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketTypeName: 'VIP',
        ticketTypeCode: 'VIP',
        unitPrice: 25.5, // 2550 cents -> major unit
        currency: 'USD',
        reservationId: 'res-1',
      }),
    );
  });

  it('passes smallest-unit price straight to checkout', async () => {
    const result = await service.create(input(), 'user-1');

    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        booking_id: 'bk1',
        amount: 2550,
        currency: 'USD',
        quantity: 2,
        ticket_type_name: 'VIP',
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ checkoutClientSecret: 'sec_1' }),
    );
  });

  it('keeps zero-decimal currency amounts as-is (VND)', async () => {
    reserve.mockReturnValue(
      of({ ...snapshot, unit_price: 50000, currency: 'VND' }),
    );

    await service.create(input(), 'u1');

    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({ unitPrice: 50000, currency: 'VND' }),
    );
    expect(createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50000, currency: 'VND' }),
    );
  });

  it('does not create a booking when reservation fails', async () => {
    reserve.mockReturnValue(throwError(() => new Error('sold out')));

    await expect(service.create(input(), 'u1')).rejects.toThrow('sold out');
    expect(createPending).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('releases the hold when booking creation fails after reserve', async () => {
    createPending.mockRejectedValue(new Error('db down'));

    await expect(service.create(input(), 'u1')).rejects.toThrow('db down');
    expect(release).toHaveBeenCalledWith({
      reservation_id: 'res-1',
      booking_id: expect.any(String),
    });
  });

  it('compensates when payment checkout fails', async () => {
    createCheckout.mockReturnValue(throwError(() => new Error('stripe down')));

    await expect(service.create(input(), 'user-1')).rejects.toThrow(
      'stripe down',
    );
    expect(release).toHaveBeenCalledWith({
      reservation_id: 'res-1',
      booking_id: expect.any(String),
    });
    expect(cancel).toHaveBeenCalledWith('bk1', 'Payment checkout failed');
  });
});

describe('BookingService payment events', () => {
  let service: BookingService;
  const confirmPaid = vi.fn();
  const expireIfPending = vi.fn();
  const markPaymentFailed = vi.fn();
  const markPaid = vi.fn();
  const markRefunded = vi.fn();
  const markRefunding = vi.fn();
  const findById = vi.fn();
  const findExpiredPending = vi.fn();
  const findTerminalPaid = vi.fn();
  const findActiveByEvent = vi.fn();
  const findByEvent = vi.fn();
  const findBySession = vi.fn();
  const findByUser = vi.fn();
  const eventOwnerOf = vi.fn();
  const upsertEventCatalog = vi.fn();
  const cancel = vi.fn();
  const cancelUnlessCancelled = vi.fn();
  const cancelIfPending = vi.fn();
  const confirm = vi.fn();
  const release = vi.fn();
  const revoke = vi.fn();
  const refund = vi.fn();

  const paidBooking = {
    id: 'bk1',
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
    items: [{ reservationId: 'res-1' }],
  };

  const clientGrpcOf = (service: object) => ({
    getService: vi.fn().mockReturnValue(service),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    confirm.mockReturnValue(of({ success: true, message: '' }));
    release.mockReturnValue(of({ success: true, message: '' }));
    revoke.mockReturnValue(of({ success: true, message: '' }));
    refund.mockReturnValue(
      of({ accepted: true, refund_id: '', refunded: false }),
    );
    confirmPaid.mockResolvedValue({ count: 0 });
    expireIfPending.mockResolvedValue({ count: 0 });
    markPaymentFailed.mockResolvedValue({ count: 0 });
    markPaid.mockResolvedValue({ count: 0 });
    markRefunded.mockResolvedValue({ count: 0 });
    markRefunding.mockResolvedValue({ count: 1 });
    cancelUnlessCancelled.mockResolvedValue({ count: 1 });
    cancelIfPending.mockResolvedValue({ count: 1 });
    findExpiredPending.mockResolvedValue([]);
    findTerminalPaid.mockResolvedValue([]);
    findActiveByEvent.mockResolvedValue([]);
    findByEvent.mockResolvedValue([]);
    findBySession.mockResolvedValue([]);
    findByUser.mockResolvedValue([]);
    eventOwnerOf.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        {
          provide: 'INVENTORY_GRPC',
          useValue: clientGrpcOf({ confirm, release, revoke }),
        },
        {
          provide: 'PAYMENT_GRPC',
          useValue: clientGrpcOf({ refund }),
        },
        {
          provide: BookingRepository,
          useValue: {
            confirmPaid,
            expireIfPending,
            markPaymentFailed,
            markPaid,
            markRefunded,
            markRefunding,
            findById,
            findExpiredPending,
            findTerminalPaid,
            findActiveByEvent,
            findByEvent,
            findBySession,
            findByUser,
            eventOwnerOf,
            upsertEventCatalog,
            cancel,
            cancelUnlessCancelled,
            cancelIfPending,
          },
        },
      ],
    }).compile();

    service = module.get(BookingService);
    service.onModuleInit();
  });

  it('confirms booking and holds on payment.succeeded', async () => {
    confirmPaid.mockResolvedValue({ count: 1 });
    findById.mockResolvedValue(paidBooking);

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(confirmPaid).toHaveBeenCalledWith('bk1');
    expect(confirm).toHaveBeenCalledWith({
      reservation_id: 'res-1',
      booking_id: 'bk1',
    });
    expect(refund).not.toHaveBeenCalled();
  });

  it('requests refund and cancels when payment arrives after booking expired', async () => {
    findById.mockResolvedValue({
      ...paidBooking,
      status: 'EXPIRED',
      paymentStatus: 'PENDING',
    });

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(confirm).not.toHaveBeenCalled();
    expect(markPaid).toHaveBeenCalledWith('bk1');
    expect(refund).toHaveBeenCalledWith({
      booking_id: 'bk1',
      reason: 'Paid after booking closed',
    });
    expect(cancelUnlessCancelled).toHaveBeenCalledWith(
      'bk1',
      'Paid after booking closed',
    );
    // Refund là async: PAID → REFUNDING tới khi payment.refunded đến.
    expect(markRefunding).toHaveBeenCalledWith('bk1');
    expect(markRefunded).not.toHaveBeenCalled();
  });

  it('marks refunded immediately when payment already refunded', async () => {
    findById.mockResolvedValue({
      ...paidBooking,
      status: 'EXPIRED',
      paymentStatus: 'PENDING',
    });
    refund.mockReturnValue(
      of({ accepted: true, refund_id: 're_1', refunded: true }),
    );

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(markRefunded).toHaveBeenCalledWith('bk1');
  });

  it('leaves booking PAID when refund request fails (sweeper retries)', async () => {
    findById.mockResolvedValue({
      ...paidBooking,
      status: 'EXPIRED',
      paymentStatus: 'PENDING',
    });
    refund.mockReturnValue(throwError(() => new Error('payment down')));

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(markPaid).toHaveBeenCalledWith('bk1');
    expect(cancelUnlessCancelled).not.toHaveBeenCalled();
    expect(markRefunding).not.toHaveBeenCalled();
  });

  it('marks refunded on payment.refunded event', async () => {
    markRefunded.mockResolvedValue({ count: 1 });
    findById.mockResolvedValue(paidBooking);

    await service.handlePaymentRefunded({ booking_id: 'bk1' });

    expect(markRefunded).toHaveBeenCalledWith('bk1');
  });

  it('revokes sold holds after payment.refunded', async () => {
    markRefunded.mockResolvedValue({ count: 1 });
    findById.mockResolvedValue(paidBooking);

    await service.handlePaymentRefunded({ booking_id: 'bk1' });

    expect(revoke).toHaveBeenCalledWith({
      reservation_id: 'res-1',
      booking_id: 'bk1',
    });
  });

  it('skips revoke on duplicate payment.refunded', async () => {
    markRefunded.mockResolvedValue({ count: 0 });

    await service.handlePaymentRefunded({ booking_id: 'bk1' });

    expect(revoke).not.toHaveBeenCalled();
  });

  it('refunds a sold booking on booking.refund.requested', async () => {
    findById.mockResolvedValue({ ...paidBooking, eventId: 'evt1' });

    await service.handleRefundRequest({
      booking_id: 'bk1',
      event_id: 'evt1',
      reason: 'show moved',
    });

    expect(refund).toHaveBeenCalledWith({
      booking_id: 'bk1',
      reason: 'show moved',
    });
    expect(cancelUnlessCancelled).toHaveBeenCalledWith('bk1', 'show moved');
  });

  it('rejects refund request when event_id does not match booking', async () => {
    findById.mockResolvedValue({ ...paidBooking, eventId: 'evt1' });

    await service.handleRefundRequest({
      booking_id: 'bk1',
      event_id: 'evt-other',
    });

    expect(refund).not.toHaveBeenCalled();
    expect(cancelUnlessCancelled).not.toHaveBeenCalled();
  });

  it('skips refund request for unpaid booking', async () => {
    findById.mockResolvedValue({
      ...paidBooking,
      eventId: 'evt1',
      status: 'PENDING',
      paymentStatus: 'PENDING',
    });

    await service.handleRefundRequest({
      booking_id: 'bk1',
      event_id: 'evt1',
    });

    expect(refund).not.toHaveBeenCalled();
  });

  it('eventBookings returns list to the event owner', async () => {
    eventOwnerOf.mockResolvedValue('org1');
    findByEvent.mockResolvedValue([paidBooking]);

    const result = await service.eventBookings('evt1', { sub: 'org1' });
    expect(result).toEqual([paidBooking]);
  });

  it('eventBookings rejects non-owner viewers', async () => {
    eventOwnerOf.mockResolvedValue('org1');

    await expect(
      service.eventBookings('evt1', { sub: 'stranger' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findByEvent).not.toHaveBeenCalled();
  });

  it('eventBookings rejects when catalog is missing', async () => {
    eventOwnerOf.mockResolvedValue(null);

    await expect(
      service.eventBookings('evt1', { sub: 'org1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('booking returns to the customer who owns it', async () => {
    findById.mockResolvedValue({ ...paidBooking, userId: 'cust1' });

    const result = await service.booking('bk1', { sub: 'cust1' });
    expect(result.id).toBe('bk1');
  });

  it('booking returns to the event organizer via catalog', async () => {
    findById.mockResolvedValue({
      ...paidBooking,
      userId: 'cust1',
      eventId: 'evt1',
    });
    eventOwnerOf.mockResolvedValue('org1');

    const result = await service.booking('bk1', { sub: 'org1' });
    expect(result.id).toBe('bk1');
  });

  it('booking rejects unrelated viewers without leaking existence', async () => {
    findById.mockResolvedValue({
      ...paidBooking,
      userId: 'cust1',
      eventId: 'evt1',
    });
    eventOwnerOf.mockResolvedValue('org1');

    await expect(
      service.booking('bk1', { sub: 'stranger' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('myBookings returns the caller own bookings', async () => {
    findByUser.mockResolvedValue([paidBooking]);

    const result = await service.myBookings({ sub: 'cust1' });
    expect(result).toEqual([paidBooking]);
    expect(findByUser).toHaveBeenCalledWith('cust1');
  });

  it('handleEventPublished upserts the catalog', async () => {
    await service.handleEventPublished({
      event_id: 'evt1',
      organizer_id: 'org1',
    });
    expect(upsertEventCatalog).toHaveBeenCalledWith('evt1', 'org1');
  });

  it('cancels pending and refunds paid bookings on event.cancelled', async () => {
    findActiveByEvent.mockResolvedValue([
      {
        id: 'bk-pending',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        items: [{ reservationId: 'res-1' }],
      },
      { ...paidBooking, id: 'bk-paid' },
    ]);

    const processed = await service.handleEventCancelled({
      event_id: 'evt1',
      reason: 'storm',
    });

    expect(processed).toBe(2);
    expect(cancelIfPending).toHaveBeenCalledWith('bk-pending', 'storm');
    expect(release).toHaveBeenCalledWith({
      reservation_id: 'res-1',
      booking_id: 'bk-pending',
    });
    expect(refund).toHaveBeenCalledWith({
      booking_id: 'bk-paid',
      reason: 'storm',
    });
  });

  it('retries refund for terminal bookings still PAID', async () => {
    findTerminalPaid.mockResolvedValue([{ id: 'bk1' }, { id: 'bk2' }]);

    const retried = await service.sweepStuckRefunds(50);

    expect(retried).toBe(2);
    expect(refund).toHaveBeenCalledTimes(2);
  });

  it('refunds when hold is gone by the time payment succeeded', async () => {
    confirmPaid.mockResolvedValue({ count: 1 });
    findById.mockResolvedValue(paidBooking);
    confirm.mockReturnValue(of({ success: false, message: 'not active' }));

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(refund).toHaveBeenCalled();
    expect(cancelUnlessCancelled).toHaveBeenCalled();
  });

  it('skips duplicate payment.succeeded on a refunded booking', async () => {
    findById.mockResolvedValue({ ...paidBooking, paymentStatus: 'REFUNDED' });

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(refund).not.toHaveBeenCalled();
  });

  it('expires booking and releases holds on payment.expired', async () => {
    expireIfPending.mockResolvedValue({ count: 1 });
    findById.mockResolvedValue(paidBooking);

    await service.handlePaymentExpired({ booking_id: 'bk1' });

    expect(release).toHaveBeenCalledWith({
      reservation_id: 'res-1',
      booking_id: 'bk1',
    });
  });

  it('only marks paymentFailedAt on payment.failed', async () => {
    await service.handlePaymentFailed({ booking_id: 'bk1' });

    expect(markPaymentFailed).toHaveBeenCalledWith('bk1');
    expect(release).not.toHaveBeenCalled();
  });

  it('sweeps expired pending bookings and releases their holds', async () => {
    findExpiredPending.mockResolvedValue([
      { id: 'bk1', items: [{ reservationId: 'res-1' }] },
      { id: 'bk2', items: [{ reservationId: 'res-2' }] },
    ]);
    expireIfPending
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const swept = await service.sweepExpiredBookings(new Date(), 100);

    expect(swept).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({
      reservation_id: 'res-1',
      booking_id: 'bk1',
    });
  });
});
