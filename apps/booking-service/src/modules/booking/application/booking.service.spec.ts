import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
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

  it('still returns the booking when payment fails', async () => {
    createCheckout.mockReturnValue(throwError(() => new Error('stripe down')));

    const result = await service.create(input(), 'user-1');

    expect(result).toEqual(
      expect.objectContaining({ id: 'bk1', checkoutClientSecret: undefined }),
    );
    expect(release).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
