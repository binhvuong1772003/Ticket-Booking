import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { randomBytes } from 'node:crypto';
import { CreateBookingInput } from '../presentation/graphql/inputs/create-booking.input';
import { BookingRepository } from '../infrastructure/booking.repository';

interface ReserveRequest {
  session_id: string;
  ticket_type_id: string;
  quantity: number;
  booking_id: string;
  user_id: string;
}

interface ReserveResponse {
  success: boolean;
  reservation_id: string;
  message: string;
  ticket_type_name: string;
  ticket_type_code: string;
  unit_price: number;
  currency: string;
}

interface ReleaseRequest {
  reservation_id: string;
  booking_id: string;
}

interface ReleaseResponse {
  success: boolean;
  message: string;
}

interface InventoryGrpcService {
  reserve(input: ReserveRequest): Observable<ReserveResponse>;
  release(input: ReleaseRequest): Observable<ReleaseResponse>;
}

interface CreateCheckoutRequest {
  booking_id: string;
  amount: number;
  currency: string;
  organizer_account_id: string;
  quantity: number;
  ticket_type_name: string;
  success_url: string;
}

interface CreateCheckoutResponse {
  success: boolean;
  checkout_session_id: string;
  client_secret: string;
  message: string;
}

interface PaymentGrpcService {
  createCheckout(
    input: CreateCheckoutRequest,
  ): Observable<CreateCheckoutResponse>;
}

// Tiền zero-decimal: đơn vị nhỏ nhất trùng đơn vị lớn (VND 50000 = 50000)
const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'JPY', 'KRW', 'VND']);

function fromSmallestUnit(amount: number, currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())
    ? amount
    : amount / 100;
}

type CreateBookingMessage = {
  booking_id: string;
  user_id: string;
  session_id: string;
  ticket_type_id: string;
  quantity: number;
};

@Injectable()
export class BookingService implements OnModuleInit {
  private readonly logger = new Logger(BookingService.name);
  private inventoryService!: InventoryGrpcService;
  private paymentService!: PaymentGrpcService;

  constructor(
    @Inject('INVENTORY_GRPC')
    private readonly inventoryClient: ClientGrpc,
    @Inject('PAYMENT_GRPC')
    private readonly paymentClient: ClientGrpc,
    private readonly bookingRepository: BookingRepository,
  ) {}

  onModuleInit() {
    this.inventoryService =
      this.inventoryClient.getService<InventoryGrpcService>('InventoryService');
    this.paymentService =
      this.paymentClient.getService<PaymentGrpcService>('PaymentService');
  }

  getHealth() {
    return { service: 'booking-service', status: 'ok' };
  }

  async create(input: CreateBookingInput, userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException('Authenticated user is required');
    }

    const bookingId = randomBytes(12).toString('hex');
    let reservationId: string | undefined;
    let booking: { id: string } | undefined;

    try {
      const reservation = await this.reserveInventory({
        booking_id: bookingId,
        user_id: userId,
        session_id: input.sessionId,
        ticket_type_id: input.ticketTypeId,
        quantity: input.quantity,
      });

      reservationId = reservation.reservation_id;

      const currency = reservation.currency || 'USD';
      const unitPrice = fromSmallestUnit(reservation.unit_price, currency);

      booking = await this.bookingRepository.createPending({
        id: bookingId,
        userId,
        eventId: input.eventId,
        sessionId: input.sessionId,
        ticketTypeId: input.ticketTypeId,
        ticketTypeName: reservation.ticket_type_name,
        ticketTypeCode: reservation.ticket_type_code,
        quantity: input.quantity,
        unitPrice,
        currency,
        reservationId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const checkoutClientSecret = await this.createCheckout(booking.id, {
        amount: reservation.unit_price,
        currency,
        quantity: input.quantity,
        ticketTypeName: reservation.ticket_type_name,
      });

      return { ...booking, checkoutClientSecret };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`createBooking ${bookingId} failed: ${message}`);
      if (reservationId) {
        await this.releaseInventory(reservationId, bookingId).catch(
          (releaseError: unknown) => {
            const releaseMessage =
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError);
            this.logger.error(
              `releaseInventory ${reservationId} for booking ${bookingId} failed: ${releaseMessage}`,
            );
          },
        );
      }
      if (booking) {
        await this.bookingRepository.cancel(
          booking.id,
          'Payment checkout failed',
        );
      }
      throw error;
    }
  }

  private reserveInventory(input: CreateBookingMessage) {
    return firstValueFrom(
      this.inventoryService.reserve({
        session_id: input.session_id,
        ticket_type_id: input.ticket_type_id,
        quantity: input.quantity,
        booking_id: input.booking_id,
        user_id: input.user_id,
      }),
    );
  }

  private releaseInventory(reservationId: string, bookingId: string) {
    return firstValueFrom(
      this.inventoryService.release({
        reservation_id: reservationId,
        booking_id: bookingId,
      }),
    );
  }

  private createCheckout(
    bookingId: string,
    ticket: {
      amount: number;
      currency: string;
      quantity: number;
      ticketTypeName: string;
    },
  ) {
    return firstValueFrom(
      this.paymentService.createCheckout({
        booking_id: bookingId,
        amount: ticket.amount,
        currency: ticket.currency,
        organizer_account_id: '',
        quantity: ticket.quantity,
        ticket_type_name: ticket.ticketTypeName,
        success_url: '',
      }),
    ).then((res) => res.client_secret);
  }
}
