import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { NEVER, of, Subject, throwError } from 'rxjs';
import { NotFoundException } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingRepository } from '../infrastructure/booking.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';
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
  ticket_type_id: 'tt1',
  session_id: 'sess1',
  event_id: 'evt1',
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
  const markInventoryReleased = vi.fn();
  const clearInventoryCompensation = vi.fn();
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
        useValue: {
          createPending,
          cancel,
          markInventoryReleased,
          clearInventoryCompensation,
        },
        },
        {
          provide: OutboxProcessor,
          useValue: { wake: vi.fn() },
        },
      ],
    }).compile();

    service = module.get(BookingService);
    service.onModuleInit();
  });

  it('creates booking from the inventory snapshot, not client input', async () => {
    await service.create(input(), 'user-1');

    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 'evt1',
        session_id: 'sess1',
        ticket_type_id: 'tt1',
      }),
    );
    expect(createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt1',
        sessionId: 'sess1',
        ticketTypeId: 'tt1',
        ticketTypeName: 'VIP',
        ticketTypeCode: 'VIP',
        unitPrice: 25.5, // 2550 cents -> major unit
        unitPriceMinor: 2550,
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

  it('returns a stable GraphQL error without booking or checkout before sales open', async () => {
    reserve.mockReturnValue(
      throwError(() =>
        Object.assign(
          new Error('9 FAILED_PRECONDITION: Ticket sales have not started'),
          { code: 9, details: 'Ticket sales have not started' },
        ),
      ),
    );
    await expect(service.create(input(), 'u1')).rejects.toMatchObject({
      extensions: { code: 'TICKET_SALES_NOT_STARTED' },
    });
    expect(createPending).not.toHaveBeenCalled();
    expect(createCheckout).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('preserves unrelated inventory errors', async () => {
    const error = Object.assign(new Error('Ticket type is not on sale'), {
      code: 9,
      details: 'Ticket type is not on sale',
    });
    reserve.mockReturnValue(throwError(() => error));
    await expect(service.create(input(), 'u1')).rejects.toBe(error);
  });

  it('does not create a booking when reservation fails', async () => {
    reserve.mockReturnValue(throwError(() => new Error('sold out')));

    await expect(service.create(input(), 'u1')).rejects.toThrow('sold out');
    expect(createPending).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it.each([
    ['unsuccessful response', { success: false }],
    ['missing event ID', { event_id: undefined }],
    ['wrong event ID', { event_id: 'evt-other' }],
    ['missing session ID', { session_id: undefined }],
    ['wrong session ID', { session_id: 'sess-other' }],
    ['missing ticket type ID', { ticket_type_id: undefined }],
    ['wrong ticket type ID', { ticket_type_id: 'tt-other' }],
  ])(
    'releases a reservation and skips booking/checkout for %s',
    async (_name, fields) => {
      reserve.mockReturnValue(of({ ...snapshot, ...fields }));

      await expect(service.create(input(), 'user-1')).rejects.toThrow(
        'Inventory returned an invalid reservation',
      );

      expect(release).toHaveBeenCalledWith({
        reservation_id: 'res-1',
        booking_id: expect.any(String),
      });
      expect(createPending).not.toHaveBeenCalled();
      expect(createCheckout).not.toHaveBeenCalled();
    },
  );

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
  const recordPaymentSucceeded = vi.fn();
  const claimConfirmation = vi.fn();
  const completeConfirmation = vi.fn();
  const noteConfirmationFailure = vi.fn();
  const findConfirming = vi.fn();
  const cancelForRefund = vi.fn();
  const claimRefundWork = vi.fn();
  const markInventoryReleased = vi.fn();
  const clearInventoryCompensation = vi.fn();
  const expireIfPending = vi.fn();
  const markPaymentFailed = vi.fn();
  const markRefunded = vi.fn();
  const markRefunding = vi.fn();
  const findById = vi.fn();
  const findExpiredPending = vi.fn();
  const findRefundWork = vi.fn();
  const cancelActiveByEvent = vi.fn();
  const findByEvent = vi.fn();
  const findBySession = vi.fn();
  const findByUser = vi.fn();
  const eventOwnerOf = vi.fn();
  const upsertEventCatalog = vi.fn();
  const confirm = vi.fn();
  const release = vi.fn();
  const revoke = vi.fn();
  const refund = vi.fn();
  const wake = vi.fn();

  const confirmingBooking = {
    id: 'bk1',
    status: 'CONFIRMING',
    paymentStatus: 'PAID',
    inventoryCompensationPending: false,
    items: [{ reservationId: 'res-1' }],
  };
  const paidBooking = {
    id: 'bk1',
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
    inventoryCompensationPending: false,
    items: [{ reservationId: 'res-1' }],
  };
  const closedPaidBooking = {
    ...confirmingBooking,
    status: 'CANCELLED',
    inventoryCompensationPending: true,
  };

  const clientGrpcOf = (grpcService: object) => ({
    getService: vi.fn().mockReturnValue(grpcService),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    recordPaymentSucceeded.mockResolvedValue({ count: 0 });
    claimConfirmation.mockResolvedValue({ count: 1 });
    completeConfirmation.mockResolvedValue({ count: 1 });
    noteConfirmationFailure.mockResolvedValue({ count: 1 });
    cancelForRefund.mockResolvedValue({ count: 1 });
    claimRefundWork.mockResolvedValue({ count: 1 });
    markInventoryReleased.mockResolvedValue({ count: 1 });
    clearInventoryCompensation.mockResolvedValue({ count: 1 });
    expireIfPending.mockResolvedValue({ count: 0 });
    markPaymentFailed.mockResolvedValue({ count: 0 });
    markRefunded.mockResolvedValue({ count: 1 });
    markRefunding.mockResolvedValue({ count: 1 });
    findById.mockResolvedValue(confirmingBooking);
    findExpiredPending.mockResolvedValue([]);
    findRefundWork.mockResolvedValue([]);
    findConfirming.mockResolvedValue([]);
    cancelActiveByEvent.mockResolvedValue({ count: 0 });
    findByEvent.mockResolvedValue([]);
    findBySession.mockResolvedValue([]);
    findByUser.mockResolvedValue([]);
    eventOwnerOf.mockResolvedValue(null);
    confirm.mockReturnValue(of({ success: true, message: '' }));
    release.mockReturnValue(of({ success: true, message: '' }));
    revoke.mockReturnValue(of({ success: true, message: '' }));
    refund.mockReturnValue(
      of({ accepted: true, refund_id: 're_1', refunded: false }),
    );

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
            recordPaymentSucceeded,
            claimConfirmation,
            completeConfirmation,
            noteConfirmationFailure,
            findConfirming,
            cancelForRefund,
            claimRefundWork,
            markInventoryReleased,
            clearInventoryCompensation,
            expireIfPending,
            markPaymentFailed,
            markRefunded,
            markRefunding,
            findById,
            findExpiredPending,
            findRefundWork,
            cancelActiveByEvent,
            findByEvent,
            findBySession,
            findByUser,
            eventOwnerOf,
            upsertEventCatalog,
          },
        },
        { provide: OutboxProcessor, useValue: { wake } },
      ],
    }).compile();

    service = module.get(BookingService);
    service.onModuleInit();
  });

  it('does not complete or wake while Inventory.confirm is still pending', async () => {
    const response = new Subject<{ success: boolean; message: string }>();
    confirm.mockReturnValue(response);
    findById.mockResolvedValue(confirmingBooking);

    const handling = service.handlePaymentSucceeded({ booking_id: 'bk1' });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));

    expect(completeConfirmation).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();

    response.next({ success: true, message: 'Hold confirmed' });
    response.complete();
    await handling;

    expect(completeConfirmation).toHaveBeenCalledWith('bk1');
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('writes the final confirmation only after every reservation succeeds', async () => {
    const order: string[] = [];
    findById.mockResolvedValue({
      ...confirmingBooking,
      items: [{ reservationId: 'res-1' }, { reservationId: 'res-2' }],
    });
    confirm.mockImplementation(({ reservation_id }) => {
      order.push('confirm:' + reservation_id);
      return of({ success: true, message: '' });
    });
    completeConfirmation.mockImplementation(async () => {
      order.push('complete');
      return { count: 1 };
    });
    wake.mockImplementation(() => order.push('wake'));

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(order).toEqual([
      'confirm:res-1',
      'confirm:res-2',
      'complete',
      'wake',
    ]);
    expect(completeConfirmation).toHaveBeenCalledTimes(1);
  });

  it('cancels and refunds after a definite Inventory business failure', async () => {
    const order: string[] = [];
    confirm.mockReturnValue(
      of({ success: false, message: 'Hold not active' }),
    );
    cancelForRefund.mockImplementation(async () => {
      order.push('terminal');
      return { count: 1 };
    });
    refund.mockImplementation(() => {
      order.push('refund');
      return of({ accepted: true, refund_id: 're_1', refunded: false });
    });
    findById.mockResolvedValue(closedPaidBooking);

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(order).toEqual(['terminal', 'refund']);
    expect(completeConfirmation).not.toHaveBeenCalled();
    expect(markRefunding).toHaveBeenCalledWith('bk1');
  });

  it('keeps CONFIRMING after a transport error with unknown Inventory outcome', async () => {
    confirm.mockReturnValue(throwError(() => new Error('deadline exceeded')));

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(noteConfirmationFailure).toHaveBeenCalledWith(
      'bk1',
      'deadline exceeded',
    );
    expect(completeConfirmation).not.toHaveBeenCalled();
    expect(cancelForRefund).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it('leaves persisted CONFIRMING + PAID work for the sweeper after Inventory timeout', async () => {
    confirm.mockReturnValueOnce(
      throwError(() => new Error('deadline exceeded')),
    );

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });
    expect(noteConfirmationFailure).toHaveBeenCalledWith(
      'bk1',
      'deadline exceeded',
    );

    findConfirming.mockResolvedValue([confirmingBooking]);
    await service.sweepConfirmingBookings(new Date(), 50);

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(completeConfirmation).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledOnce();
  });

  it('times out a missing Inventory response and keeps the result unknown', async () => {
    vi.useFakeTimers();
    const response = new Subject<{ success: boolean; message: string }>();
    confirm.mockReturnValue(response);
    let settled = false;
    try {
      const handling = service
        .handlePaymentSucceeded({ booking_id: 'bk1' })
        .then(() => {
          settled = true;
        });
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
      }
      expect(confirm).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.resolve();
      await Promise.resolve();
      const timedOut = settled;
      if (!timedOut) {
        response.next({ success: true, message: '' });
        response.complete();
      }
      await handling;
      expect(timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    expect(noteConfirmationFailure).toHaveBeenCalled();
    expect(completeConfirmation).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it('retries safely when Inventory committed but the response was lost', async () => {
    confirm
      .mockReturnValueOnce(throwError(() => new Error('connection reset')))
      .mockReturnValueOnce(
        of({ success: true, message: 'Already confirmed' }),
      );

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });
    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(completeConfirmation).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
  });

  it('does not create a second confirmation when duplicate payment handlers race', async () => {
    claimConfirmation
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });
    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(completeConfirmation).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('recovers a stuck CONFIRMING booking through the sweeper', async () => {
    findConfirming.mockResolvedValue([confirmingBooking]);

    const recovered = await service.sweepConfirmingBookings(new Date(), 50);

    expect(recovered).toBe(1);
    expect(confirm).toHaveBeenCalledWith({
      reservation_id: 'res-1',
      booking_id: 'bk1',
    });
    expect(completeConfirmation).toHaveBeenCalledWith('bk1');
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('does not finalize a booking cancelled while Inventory.confirm was running', async () => {
    completeConfirmation.mockResolvedValue({ count: 0 });
    findById
      .mockResolvedValueOnce(confirmingBooking)
      .mockResolvedValueOnce(closedPaidBooking);

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(completeConfirmation).toHaveBeenCalledTimes(1);
    expect(wake).not.toHaveBeenCalled();
    expect(cancelForRefund).toHaveBeenCalledWith(
      'bk1',
      expect.any(String),
    );
    expect(refund).toHaveBeenCalledWith({
      booking_id: 'bk1',
      reason: expect.any(String),
    });
  });

  it('does not confirm a late payment for a terminal booking', async () => {
    findById.mockResolvedValue(closedPaidBooking);

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(claimConfirmation).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(completeConfirmation).not.toHaveBeenCalled();
    expect(refund).toHaveBeenCalled();
  });

  it('treats an item without a reservation as a definite confirmation failure', async () => {
    findById.mockResolvedValue({
      ...confirmingBooking,
      items: [{ reservationId: null }],
    });
    refund.mockReturnValue(
      of({ accepted: true, refund_id: 're_1', refunded: true }),
    );
    markRefunded.mockResolvedValue({ count: 1 });

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(confirm).not.toHaveBeenCalled();
    expect(completeConfirmation).not.toHaveBeenCalled();
    expect(cancelForRefund).toHaveBeenCalled();
    expect(refund).toHaveBeenCalled();
  });

  it('releases active holds and revokes confirmed holds after partial failure', async () => {
    findById.mockResolvedValue({
      ...confirmingBooking,
      items: [{ reservationId: 'res-confirmed' }, { reservationId: 'res-active' }],
    });
    confirm
      .mockReturnValueOnce(of({ success: true, message: '' }))
      .mockReturnValueOnce(of({ success: false, message: 'Hold not active' }));
    refund.mockReturnValue(
      of({ accepted: true, refund_id: 're_1', refunded: true }),
    );
    markRefunded.mockResolvedValue({ count: 1 });

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(completeConfirmation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(clearInventoryCompensation).toHaveBeenCalledWith('bk1');
  });

  it('persists terminal state before refund and leaves retry work after refund RPC failure', async () => {
    const order: string[] = [];
    cancelForRefund.mockImplementation(async () => {
      order.push('terminal');
      return { count: 1 };
    });
    refund.mockImplementation(() => {
      order.push('refund');
      return throwError(() => new Error('payment unavailable'));
    });
    findById.mockResolvedValue(closedPaidBooking);

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(order).toEqual(['terminal', 'refund']);
    expect(markRefunding).not.toHaveBeenCalled();

    findRefundWork.mockResolvedValue([closedPaidBooking]);
    await service.sweepStuckRefunds(50);
    expect(refund).toHaveBeenCalledTimes(2);
  });

  it('times out an unknown refund response without marking it refunding', async () => {
    vi.useFakeTimers();
    confirm.mockReturnValue(of({ success: false, message: 'Hold expired' }));
    refund.mockReturnValue(NEVER);
    findById.mockResolvedValue(closedPaidBooking);
    let settled = false;
    try {
      void service
        .handlePaymentSucceeded({ booking_id: 'bk1' })
        .then(() => (settled = true), () => (settled = true));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }

    expect(settled).toBe(true);
    expect(claimRefundWork).toHaveBeenCalledWith(
      'bk1',
      expect.any(Date),
      60_000,
    );
    expect(markInventoryReleased).toHaveBeenCalledWith('bk1');
    expect(markRefunding).not.toHaveBeenCalled();
    expect(markRefunded).not.toHaveBeenCalled();
    expect(clearInventoryCompensation).not.toHaveBeenCalled();
  });

  it('retries inventory compensation after payment.refunded was delivered', async () => {
    markRefunded.mockResolvedValue({ count: 0 });
    findById.mockResolvedValue({
      ...closedPaidBooking,
      paymentStatus: 'REFUNDED',
      inventoryCompensationPending: true,
    });

    await service.handlePaymentRefunded({ booking_id: 'bk1' });

    expect(release).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalled();
    expect(clearInventoryCompensation).toHaveBeenCalledWith('bk1');
  });

  it('times out release and leaves inventory compensation pending', async () => {
    vi.useFakeTimers();
    expireIfPending.mockResolvedValue({ count: 1 });
    findById.mockResolvedValue({
      id: 'bk1',
      status: 'EXPIRED',
      paymentStatus: 'PENDING',
      items: [{ reservationId: 'res-1' }],
    });
    release.mockReturnValue(NEVER);
    let settled = false;
    try {
      void service
        .handlePaymentExpired({ booking_id: 'bk1' })
        .then(() => (settled = true), () => (settled = true));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }

    expect(settled).toBe(true);
    expect(markInventoryReleased).not.toHaveBeenCalled();
    expect(clearInventoryCompensation).not.toHaveBeenCalled();
  });

  it('times out revoke and leaves inventory compensation pending', async () => {
    vi.useFakeTimers();
    markRefunded.mockResolvedValue({ count: 1 });
    findById.mockResolvedValue({
      ...closedPaidBooking,
      paymentStatus: 'REFUNDED',
      inventoryCompensationPending: true,
    });
    revoke.mockReturnValue(NEVER);
    let settled = false;
    try {
      void service
        .handlePaymentRefunded({ booking_id: 'bk1' })
        .then(() => (settled = true), () => (settled = true));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }

    expect(settled).toBe(true);
    expect(revoke).toHaveBeenCalled();
    expect(clearInventoryCompensation).not.toHaveBeenCalled();
  });

  it('does not move refunding or refunded payment status back to PAID', async () => {
    findById.mockResolvedValue({
      ...closedPaidBooking,
      paymentStatus: 'REFUNDING',
    });

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(confirm).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it('retries payment.succeeded after the first durable database write fails', async () => {
    const databaseError = new Error('database unavailable');
    recordPaymentSucceeded
      .mockRejectedValueOnce(databaseError)
      .mockResolvedValueOnce({ count: 1 });
    findById.mockResolvedValue(confirmingBooking);

    await expect(
      service.handlePaymentSucceeded({ booking_id: 'bk1' }),
    ).rejects.toBe(databaseError);
    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(recordPaymentSucceeded).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledOnce();
    expect(completeConfirmation).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledOnce();
  });

  it('does not repeat confirmation side effects for a redelivered paid booking', async () => {
    recordPaymentSucceeded.mockResolvedValue({ count: 0 });
    findById.mockResolvedValue(paidBooking);

    await service.handlePaymentSucceeded({ booking_id: 'bk1' });
    await service.handlePaymentSucceeded({ booking_id: 'bk1' });

    expect(confirm).not.toHaveBeenCalled();
    expect(completeConfirmation).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it('does not acknowledge payment or refund events for a missing booking', async () => {
    findById.mockResolvedValue(null);

    const operations = [
      () => service.handlePaymentSucceeded({ booking_id: 'missing' }),
      () => service.handlePaymentExpired({ booking_id: 'missing' }),
      () => service.handlePaymentFailed({ booking_id: 'missing' }),
      () => service.handlePaymentRefunded({ booking_id: 'missing' }),
      () =>
        service.handleRefundRequest({
          booking_id: 'missing',
          event_id: 'evt1',
        }),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toThrow(/booking.*not found/i);
    }
  });

  it('expires a pending booking and releases its hold', async () => {
    expireIfPending.mockResolvedValue({ count: 1 });
    findById.mockResolvedValue({
      id: 'bk1',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      items: [{ reservationId: 'res-1' }],
    });

    await service.handlePaymentExpired({ booking_id: 'bk1' });

    expect(release).toHaveBeenCalledWith({
      reservation_id: 'res-1',
      booking_id: 'bk1',
    });
    expect(clearInventoryCompensation).toHaveBeenCalledWith('bk1');
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
    expect(clearInventoryCompensation).toHaveBeenCalledTimes(1);
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
    expect(cancelForRefund).toHaveBeenCalledWith('bk1', 'show moved');
  });

  it('rejects a refund request when event_id does not match', async () => {
    findById.mockResolvedValue({ ...paidBooking, eventId: 'evt1' });

    await expect(
      service.handleRefundRequest({
        booking_id: 'bk1',
        event_id: 'evt-other',
      }),
    ).rejects.toThrow('Refund request event does not match booking bk1');

    expect(refund).not.toHaveBeenCalled();
  });

  it('returns bookings to their event owner', async () => {
    eventOwnerOf.mockResolvedValue('org1');
    findByEvent.mockResolvedValue([paidBooking]);

    await expect(
      service.eventBookings('evt1', { sub: 'org1' }),
    ).resolves.toEqual([paidBooking]);
  });

  it('rejects event booking reads from a non-owner', async () => {
    eventOwnerOf.mockResolvedValue('org1');

    await expect(
      service.eventBookings('evt1', { sub: 'stranger' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findByEvent).not.toHaveBeenCalled();
  });

  it('rejects event booking reads when the catalog is missing', async () => {
    eventOwnerOf.mockResolvedValue(null);

    await expect(
      service.eventBookings('evt1', { sub: 'org1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns a booking to its customer', async () => {
    findById.mockResolvedValue({ ...paidBooking, userId: 'customer-1' });

    await expect(
      service.booking('bk1', { sub: 'customer-1' }),
    ).resolves.toMatchObject({ id: 'bk1' });
  });

  it('returns a booking to its event organizer', async () => {
    findById.mockResolvedValue({
      ...paidBooking,
      userId: 'customer-1',
      eventId: 'evt1',
    });
    eventOwnerOf.mockResolvedValue('org1');

    await expect(
      service.booking('bk1', { sub: 'org1' }),
    ).resolves.toMatchObject({ id: 'bk1' });
  });

  it('hides a booking from unrelated viewers', async () => {
    findById.mockResolvedValue({
      ...paidBooking,
      userId: 'customer-1',
      eventId: 'evt1',
    });
    eventOwnerOf.mockResolvedValue('org1');

    await expect(
      service.booking('bk1', { sub: 'stranger' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns only the caller’s bookings', async () => {
    findByUser.mockResolvedValue([paidBooking]);

    await expect(service.myBookings({ sub: 'customer-1' })).resolves.toEqual([
      paidBooking,
    ]);
    expect(findByUser).toHaveBeenCalledWith('customer-1');
  });

  it('skips a refund request for an unpaid booking', async () => {
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

  it('keeps inventory compensation idempotent on duplicate payment.refunded', async () => {
    markRefunded.mockResolvedValue({ count: 0 });
    findById.mockResolvedValue({
      ...closedPaidBooking,
      paymentStatus: 'REFUNDED',
      inventoryCompensationPending: false,
    });

    await service.handlePaymentRefunded({ booking_id: 'bk1' });

    expect(revoke).not.toHaveBeenCalled();
  });

  it('handles event.published by updating the local catalog', async () => {
    await service.handleEventPublished({
      event_id: 'evt1',
      organizer_id: 'org1',
    });

    expect(upsertEventCatalog).toHaveBeenCalledWith('evt1', 'org1');
  });

  it('cancels a CONFIRMING booking from event.cancelled', async () => {
    cancelActiveByEvent.mockResolvedValue({ count: 1 });

    await service.handleEventCancelled({
      event_id: 'evt1',
      reason: 'event cancelled',
    });

    expect(cancelActiveByEvent).toHaveBeenCalledWith(
      'evt1',
      'event cancelled',
    );
    expect(refund).not.toHaveBeenCalled();
  });

  it('propagates failure to persist event cancellation work', async () => {
    const error = new Error('database unavailable');
    cancelActiveByEvent.mockRejectedValue(error);

    await expect(
      service.handleEventCancelled({ event_id: 'evt1' }),
    ).rejects.toBe(error);
  });
});
