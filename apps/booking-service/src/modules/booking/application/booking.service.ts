import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout } from 'rxjs';
import { randomBytes } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { isEmail } from 'class-validator';
import { CreateBookingInput } from '../presentation/graphql/inputs/create-booking.input';
import {
  BookingRepository,
  TrendingSalesCursor,
} from '../infrastructure/booking.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';

interface ReserveRequest {
  session_id: string;
  event_id: string;
  ticket_type_id: string;
  quantity: number;
  booking_id: string;
  user_id: string;
}

interface ReserveResponse {
  success: boolean;
  reservation_id: string;
  ticket_type_id: string;
  session_id: string;
  event_id: string;
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

interface ConfirmRequest {
  reservation_id: string;
  booking_id: string;
}

interface ConfirmResponse {
  success: boolean;
  message: string;
}

interface RevokeRequest {
  reservation_id: string;
  booking_id: string;
}

interface RevokeResponse {
  success: boolean;
  message: string;
}

interface InventoryGrpcService {
  reserve(input: ReserveRequest): Observable<ReserveResponse>;
  release(input: ReleaseRequest): Observable<ReleaseResponse>;
  confirm(input: ConfirmRequest): Observable<ConfirmResponse>;
  revoke(input: RevokeRequest): Observable<RevokeResponse>;
}

interface CreateCheckoutRequest {
  booking_id: string;
  user_id: string;
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

interface RefundRequest {
  booking_id: string;
  reason: string;
}

interface RefundResponse {
  accepted: boolean;
  refund_id: string;
  refunded: boolean;
}

interface PaymentGrpcService {
  createCheckout(
    input: CreateCheckoutRequest,
  ): Observable<CreateCheckoutResponse>;
  refund(input: RefundRequest): Observable<RefundResponse>;
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
  event_id: string;
  session_id: string;
  ticket_type_id: string;
  quantity: number;
};

// Envelope do OutboxProcessor của payment-service emit:
// { eventId, eventType, occurredAt, payload }
export type PaymentEventPayload = {
  booking_id?: string;
  payment_intent_id?: string;
};

// Payload 'booking.refund.requested' do event-service emit sau khi verify
// organizer sở hữu event. Consumer vẫn phải check booking.eventId khớp
// event_id — client gửi cả hai, binding là thứ chống spoof.
export type RefundRequestPayload = {
  booking_id?: string;
  event_id?: string;
  reason?: string;
};

// Payload 'event.cancelled' do event-service emit trong cùng tx với
// status change. Cascade: booking PENDING → CANCELLED + release hold,
// CONFIRMED+PAID → refund.
export type EventCancelledPayload = {
  event_id?: string;
  reason?: string;
};

type BookingWithInventory = {
  id: string;
  status: string;
  paymentStatus: string;
  confirmationAttempts?: number;
  cancellationReason?: string | null;
  inventoryCompensationPending?: boolean | null;
  inventoryReleasedAt?: Date | null;
  items: { reservationId: string | null }[];
};

const CONFIRMATION_RETRY_BASE_MS = 30_000;
const CONFIRMATION_RETRY_MAX_MS = 5 * 60_000;
const INVENTORY_CONFIRM_TIMEOUT_MS = 10_000;
const INVENTORY_COMPENSATION_TIMEOUT_MS = 10_000;
const REFUND_TIMEOUT_MS = 10_000;
const COMPENSATION_RETRY_DELAY_MS = 60_000;

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
    private readonly outboxProcessor: OutboxProcessor,
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

  async ticketBookingItemSnapshot(itemId: string) {
    const snapshot = await this.bookingRepository.ticketBookingItemSnapshot(itemId);
    if (!snapshot) throw new NotFoundException('Confirmed booking item not found');
    return snapshot;
  }

  async internalTrendingSalesPage(input: {
    since: Date;
    first?: number;
    after?: string;
  }) {
    if (!(input.since instanceof Date) || Number.isNaN(input.since.getTime())) {
      throw new BadRequestException('since must be a valid date');
    }
    const first = input.first ?? 100;
    if (!Number.isInteger(first) || first < 1 || first > 200) {
      throw new BadRequestException('first must be between 1 and 200');
    }
    const after = input.after ? this.decodeTrendingCursor(input.after) : undefined;
    const rows = await this.bookingRepository.aggregateTrendingSales({
      since: input.since,
      first: first + 1,
      after,
    });
    const hasNextPage = rows.length > first;
    const nodes = rows.slice(0, first).map((row) => ({
      ...row,
      cursor: this.encodeTrendingCursor(row),
    }));

    return {
      nodes,
      pageInfo: {
        hasNextPage,
        endCursor: nodes.at(-1)?.cursor ?? null,
      },
    };
  }

  private encodeTrendingCursor(cursor: TrendingSalesCursor) {
    return Buffer.from(
      JSON.stringify([cursor.confirmedQuantity, cursor.eventId]),
    ).toString('base64url');
  }

  private decodeTrendingCursor(value: string): TrendingSalesCursor {
    try {
      const decoded = Buffer.from(value, 'base64url').toString();
      const cursor = JSON.parse(decoded) as unknown;
      if (
        Buffer.from(decoded).toString('base64url') !== value ||
        !Array.isArray(cursor) ||
        !Number.isSafeInteger(cursor[0]) ||
        cursor[0] < 1 ||
        typeof cursor[1] !== 'string' ||
        !/^[0-9a-f]{24}$/i.test(cursor[1])
      ) {
        throw new Error('invalid');
      }
      return { confirmedQuantity: cursor[0], eventId: cursor[1] };
    } catch {
      throw new BadRequestException('Invalid trending cursor');
    }
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
        event_id: input.eventId,
        session_id: input.sessionId,
        ticket_type_id: input.ticketTypeId,
        quantity: input.quantity,
      });

      reservationId = reservation.reservation_id;
      if (
        reservation.success !== true ||
        !reservation.reservation_id ||
        !reservation.ticket_type_id ||
        !reservation.session_id ||
        !reservation.event_id ||
        reservation.ticket_type_id !== input.ticketTypeId ||
        reservation.session_id !== input.sessionId ||
        reservation.event_id !== input.eventId
      ) {
        throw new BadRequestException(
          'Inventory returned an invalid reservation',
        );
      }

      const currency = reservation.currency || 'USD';
      const unitPrice = fromSmallestUnit(reservation.unit_price, currency);

      booking = await this.bookingRepository.createPending({
        id: bookingId,
        userId,
        eventId: reservation.event_id,
        sessionId: reservation.session_id,
        ticketTypeId: reservation.ticket_type_id,
        ticketTypeName: reservation.ticket_type_name,
        ticketTypeCode: reservation.ticket_type_code,
        quantity: input.quantity,
        unitPrice,
        unitPriceMinor: reservation.unit_price,
        currency,
        reservationId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

      const checkoutClientSecret = await this.createCheckout(booking.id, {
        userId,
        amount: reservation.unit_price,
        currency,
        quantity: input.quantity,
        ticketTypeName: reservation.ticket_type_name,
      });

      return { ...booking, checkoutClientSecret };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`createBooking ${bookingId} failed: ${message}`);
      let reservationReleased = false;
      if (reservationId) {
        try {
          reservationReleased = (
            await this.releaseInventory(reservationId, bookingId)
          ).success;
        } catch (releaseError: unknown) {
            const releaseMessage =
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError);
            this.logger.error(
              `releaseInventory ${reservationId} for booking ${bookingId} failed: ${releaseMessage}`,
            );
        }
      }
      if (booking) {
        await this.bookingRepository.cancel(
          booking.id,
          'Payment checkout failed',
        );
        if (reservationReleased) {
          await this.bookingRepository.markInventoryReleased(booking.id);
          await this.bookingRepository.clearInventoryCompensation(booking.id);
        }
      }
      throw error;
    }
  }

  async updateBookingContact(
    bookingId: string,
    contact: { fullName: string; email: string },
    userId: string,
  ) {
    const fullName = contact.fullName?.trim();
    const email = contact.email?.trim().toLowerCase();
    if (
      !fullName ||
      fullName.length < 2 ||
      fullName.length > 120 ||
      !email ||
      email.length > 254 ||
      !isEmail(email)
    ) {
      throw new BadRequestException('A valid recipient name and email are required');
    }

    const changed = await this.bookingRepository.updateRecipientIfPending(
      bookingId,
      userId,
      fullName,
      email,
      new Date(),
    );
    if (changed.count !== 1) {
      const booking = await this.bookingRepository.findById(bookingId);
      if (!booking || booking.userId !== userId) {
        throw new NotFoundException('Booking not found');
      }
      throw new BadRequestException('Booking contact can only be changed before payment');
    }

    return this.bookingRepository.findById(bookingId);
  }

  async internalBookingRecipient(bookingId: string) {
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) throw new NotFoundException('Booking not found');
    return {
      bookingId: booking.id,
      ownerId: booking.userId,
      recipientFullName: booking.recipientFullName ?? null,
      recipientEmail: booking.recipientEmail ?? null,
    };
  }

  private reserveInventory(input: CreateBookingMessage) {
    return firstValueFrom(
      this.inventoryService.reserve({
        event_id: input.event_id,
        session_id: input.session_id,
        ticket_type_id: input.ticket_type_id,
        quantity: input.quantity,
        booking_id: input.booking_id,
        user_id: input.user_id,
      }),
    ).catch((error: unknown) => {
      // ponytail: match the existing gRPC details; use structured reasons if more business errors need mapping.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 9 &&
        'details' in error &&
        error.details === 'Ticket sales have not started'
      ) {
        throw new GraphQLError('Ticket sales have not started', {
          extensions: { code: 'TICKET_SALES_NOT_STARTED' },
        });
      }
      throw error;
    });
  }

  private releaseInventory(reservationId: string, bookingId: string) {
    return firstValueFrom(
      this.inventoryService.release({
        reservation_id: reservationId,
        booking_id: bookingId,
      }).pipe(timeout({ first: INVENTORY_COMPENSATION_TIMEOUT_MS })),
    );
  }

  private createCheckout(
    bookingId: string,
    ticket: {
      userId: string;
      amount: number;
      currency: string;
      quantity: number;
      ticketTypeName: string;
    },
  ) {
    return firstValueFrom(
      this.paymentService.createCheckout({
        booking_id: bookingId,
        user_id: ticket.userId,
        amount: ticket.amount,
        currency: ticket.currency,
        organizer_account_id: '',
        quantity: ticket.quantity,
        ticket_type_name: ticket.ticketTypeName,
        success_url: '',
      }),
    ).then((res) => res.client_secret);
  }

  private confirmInventory(reservationId: string, bookingId: string) {
    return firstValueFrom(
      this.inventoryService.confirm({
        reservation_id: reservationId,
        booking_id: bookingId,
      }).pipe(timeout({ first: INVENTORY_CONFIRM_TIMEOUT_MS })),
    );
  }

  private revokeInventory(reservationId: string, bookingId: string) {
    return firstValueFrom(
      this.inventoryService.revoke({
        reservation_id: reservationId,
        booking_id: bookingId,
      }).pipe(timeout({ first: INVENTORY_COMPENSATION_TIMEOUT_MS })),
    );
  }

  private refundPayment(bookingId: string, reason: string) {
    return firstValueFrom(
      this.paymentService
        .refund({ booking_id: bookingId, reason })
        .pipe(timeout({ first: REFUND_TIMEOUT_MS })),
    );
  }

  private async attemptConfirmation(booking: BookingWithInventory) {
    const now = new Date();
    const retryDelay = Math.min(
      CONFIRMATION_RETRY_MAX_MS,
      CONFIRMATION_RETRY_BASE_MS *
        2 ** Math.min(booking.confirmationAttempts ?? 0, 4),
    );
    const { count } = await this.bookingRepository.claimConfirmation(
      booking.id,
      now,
      retryDelay,
    );
    if (count !== 1) {
      return false;
    }

    if (
      booking.items.length === 0 ||
      booking.items.some((item) => !item.reservationId?.trim())
    ) {
      await this.refundAndCancel(
        booking.id,
        'Booking is missing an inventory reservation',
      );
      return true;
    }

    for (const item of booking.items) {
      let result: ConfirmResponse;
      try {
        result = await this.confirmInventory(item.reservationId!, booking.id);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await this.bookingRepository.noteConfirmationFailure(
          booking.id,
          message,
        );
        const attempt = (booking.confirmationAttempts ?? 0) + 1;
        const log =
          `confirmInventory ${item.reservationId} for booking ${booking.id} ` +
          `has unknown outcome on retry ${attempt}: ${message}`;
        if (attempt >= 10) {
          this.logger.error(log);
        } else {
          this.logger.warn(log);
        }
        return true;
      }

      if (!result.success) {
        await this.refundAndCancel(
          booking.id,
          result.message || 'Inventory reservation could not be confirmed',
        );
        return true;
      }
    }

    const completed = await this.bookingRepository.completeConfirmation(
      booking.id,
    );
    if (completed.count === 1) {
      this.outboxProcessor.wake();
      return true;
    }

    const current = await this.bookingRepository.findById(booking.id);
    if (current?.status === 'CONFIRMED') {
      return true;
    }
    if (
      current &&
      ['CANCELLED', 'EXPIRED'].includes(current.status) &&
      (current.paymentStatus === 'PAID' ||
        current.paymentStatus === 'REFUNDING' ||
        current.paymentStatus === 'REFUNDED' ||
        current.inventoryCompensationPending)
    ) {
      await this.refundAndCancel(
        booking.id,
        current.cancellationReason ?? 'Booking closed during confirmation',
      );
    }
    return true;
  }

  async handlePaymentSucceeded(payload: PaymentEventPayload) {
    const bookingId = payload.booking_id;
    if (!bookingId) {
      throw new Error('payment.succeeded is missing booking_id');
    }

    await this.bookingRepository.recordPaymentSucceeded(bookingId);
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new Error(`Booking ${bookingId} not found`);
    }

    if (booking.status === 'CONFIRMING' && booking.paymentStatus === 'PAID') {
      await this.attemptConfirmation(booking);
      return;
    }

    if (
      booking.paymentStatus === 'REFUNDING' ||
      booking.paymentStatus === 'REFUNDED'
    ) {
      if (
        ['CANCELLED', 'EXPIRED'].includes(booking.status) &&
        booking.inventoryCompensationPending
      ) {
        await this.refundAndCancel(
          bookingId,
          booking.cancellationReason ?? 'Booking already closed',
        );
      }
      return;
    }
    if (booking.status === 'CONFIRMED') {
      return;
    }
    if (
      booking.paymentStatus === 'PAID' ||
      ['CANCELLED', 'EXPIRED'].includes(booking.status)
    ) {
      await this.refundAndCancel(bookingId, 'Paid after booking closed');
    }
  }

  async sweepConfirmingBookings(now: Date, take: number) {
    const confirming = await this.bookingRepository.findConfirming(now, take);
    let attempted = 0;
    for (const booking of confirming) {
      if (await this.attemptConfirmation(booking)) {
        attempted++;
      }
    }
    return attempted;
  }

  async handlePaymentExpired(payload: PaymentEventPayload) {
    const bookingId = payload.booking_id;
    if (!bookingId) {
      throw new Error('payment.expired is missing booking_id');
    }

    const { count } = await this.bookingRepository.expireIfPending(bookingId);
    if (count !== 1) {
      if (!(await this.bookingRepository.findById(bookingId))) {
        throw new Error(`Booking ${bookingId} not found`);
      }
      return;
    }
    const released = await this.releaseBookingHolds(bookingId);
    if (released) {
      await this.bookingRepository.markInventoryReleased(bookingId);
      await this.bookingRepository.clearInventoryCompensation(bookingId);
    }
  }

  async handlePaymentFailed(payload: PaymentEventPayload) {
    const bookingId = payload.booking_id;
    if (!bookingId) {
      throw new Error('payment.failed is missing booking_id');
    }

    // Giữ PENDING: embedded checkout cho retry; hết expiresAt sweeper dọn.
    const { count } = await this.bookingRepository.markPaymentFailed(bookingId);
    if (count !== 1 && !(await this.bookingRepository.findById(bookingId))) {
      throw new Error(`Booking ${bookingId} not found`);
    }
  }

  async sweepExpiredBookings(now: Date, take: number) {
    const expired = await this.bookingRepository.findExpiredPending(now, take);
    let swept = 0;
    for (const booking of expired) {
      const { count } = await this.bookingRepository.expireIfPending(
        booking.id,
      );
      if (count !== 1) {
        continue;
      }
      const released = await this.releaseBookingHolds(
        booking.id,
        booking.items,
      );
      if (released) {
        await this.bookingRepository.markInventoryReleased(booking.id);
        await this.bookingRepository.clearInventoryCompensation(booking.id);
      }
      swept++;
    }
    return swept;
  }

  private async releaseBookingHolds(
    bookingId: string,
    items?: { reservationId: string | null }[],
  ) {
    const booking = items
      ? { items }
      : await this.bookingRepository.findById(bookingId);
    if (!booking?.items.length) {
      return false;
    }

    let released = true;
    for (const item of booking.items) {
      if (!item.reservationId?.trim()) {
        released = false;
        this.logger.error(
          `reservation missing for booking ${bookingId}; inventory compensation remains pending`,
        );
        continue;
      }
      try {
        const result = await this.releaseInventory(item.reservationId, bookingId);
        if (!result.success) {
          released = false;
        }
      } catch (error: unknown) {
        released = false;
        this.logger.error(
          `releaseInventory ${item.reservationId} for booking ${bookingId} failed: ${String(error)}`,
        );
      }
    }
    return released;
  }

  async handlePaymentRefunded(payload: PaymentEventPayload) {
    const bookingId = payload.booking_id;
    if (!bookingId) {
      throw new Error('payment.refunded is missing booking_id');
    }

    const { count } = await this.bookingRepository.markRefunded(bookingId);
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new Error(`Booking ${bookingId} not found`);
    }
    if (count === 1 || booking.inventoryCompensationPending) {
      await this.finishRefundCompensation(
        bookingId,
        booking.items,
        Boolean(booking.inventoryReleasedAt),
      );
    }
  }

  // Organizer chủ động refund vé lẻ — lệnh từ event-service (đã verify
  // ownership phía đó). Ở đây verify binding booking↔event rồi mới refund.
  async handleRefundRequest(payload: RefundRequestPayload) {
    const bookingId = payload.booking_id;
    if (!bookingId) {
      throw new Error('booking.refund.requested is missing booking_id');
    }

    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new Error(`Booking ${bookingId} not found`);
    }
    if (booking.eventId !== payload.event_id) {
      throw new Error(`Refund request event does not match booking ${bookingId}`);
    }
    // Không bắt đầu refund khi chưa thu tiền. CONFIRMING cũng phải được đóng
    // trước khi refund để một confirm đang bay không thể hoàn tất booking.
    if (
      !['CONFIRMING', 'CONFIRMED'].includes(booking.status) ||
      booking.paymentStatus !== 'PAID'
    ) {
      this.logger.log(
        `refund request for booking ${bookingId} in ${booking.status}/${booking.paymentStatus}, skipped`,
      );
      return;
    }

    await this.refundAndCancel(
      bookingId,
      payload.reason ?? 'Refunded by organizer',
    );
  }

  // Persist the cancellation set before the sweeper performs external calls.
  async handleEventCancelled(payload: EventCancelledPayload) {
    const eventId = payload.event_id;
    if (!eventId) {
      throw new Error('event.cancelled is missing event_id');
    }
    const reason = payload.reason ?? 'Event cancelled';
    return this.bookingRepository.cancelActiveByEvent(eventId, reason);
  }

  // Booking đã đóng nhưng PAID = refund request chưa đến được payment-service
  // (gRPC fail lúc handlePaymentSucceeded). Refund RPC idempotent nên gọi lại
  // mỗi vòng sweep an toàn; khi refund xong thì payment.refunded mark REFUNDED
  // và booking tự rơi khỏi query này.
  async sweepStuckRefunds(take: number) {
    const stuck = await this.bookingRepository.findRefundWork(new Date(), take);
    for (const booking of stuck) {
      await this.refundAndCancel(
        booking.id,
        booking.cancellationReason ?? 'Paid after booking closed',
      );
    }
    return stuck.length;
  }

  // Persist terminal state and reason before external RPCs. PAID stays
  // discoverable by the sweeper if refund creation fails.
  private async refundAndCancel(bookingId: string, reason: string) {
    await this.bookingRepository.cancelForRefund(bookingId, reason);
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      return;
    }
    const claimed = await this.bookingRepository.claimRefundWork(
      bookingId,
      new Date(),
      COMPENSATION_RETRY_DELAY_MS,
    );
    if (claimed.count !== 1) {
      return;
    }
    const persistedReason = booking.cancellationReason ?? reason;

    let released = Boolean(booking.inventoryReleasedAt);
    if (!released) {
      released = await this.releaseBookingHolds(bookingId, booking.items);
      if (released) {
        await this.bookingRepository.markInventoryReleased(bookingId);
      }
    }

    if (booking.paymentStatus === 'PENDING' || booking.paymentStatus === 'FAILED') {
      if (released) {
        await this.bookingRepository.clearInventoryCompensation(bookingId);
      }
      return;
    }
    if (booking.paymentStatus === 'REFUNDED') {
      await this.finishRefundCompensation(bookingId, booking.items, released);
      return;
    }
    if (booking.paymentStatus === 'REFUNDING') {
      return;
    }
    if (booking.paymentStatus !== 'PAID') {
      return;
    }

    let result: RefundResponse;
    try {
      result = await this.refundPayment(bookingId, persistedReason);
    } catch (error) {
      this.logger.error(
        `refund request for booking ${bookingId} failed: ${String(error)}`,
      );
      return;
    }
    if (result.refunded) {
      await this.bookingRepository.markRefunded(bookingId);
      await this.finishRefundCompensation(bookingId, booking.items, released);
      return;
    }
    await this.bookingRepository.markRefunding(bookingId);
  }

  /* event.published → EventCatalog projection (eventId → organizerId).
     Bookings chỉ tồn tại sau khi event PUBLISHED (session chỉ schedule
     được trên event published) nên catalog luôn có trước booking đầu tiên. */
  async handleEventPublished(payload: {
    event_id: string;
    organizer_id: string;
  }) {
    if (!payload.event_id || !payload.organizer_id) {
      throw new Error('event.published is missing event_id or organizer_id');
    }
    await this.bookingRepository.upsertEventCatalog(
      payload.event_id,
      payload.organizer_id,
    );
  }

  /* Organizer xem danh sách vé đã đặt của event mình. Ownership check qua
     EventCatalog — catalog thiếu ⇒ không verify được ⇒ NOT_FOUND
     (không lộ sự tồn tại của data). */
  async eventBookings(eventId: string, viewer: { sub: string; role?: string }) {
    const ownerId = await this.bookingRepository.eventOwnerOf(eventId);
    if (ownerId !== viewer.sub && viewer.role !== 'ADMIN') {
      throw new NotFoundException('Event not found');
    }
    return this.bookingRepository.findByEvent(eventId);
  }

  /* Theo session: suy ra eventId từ booking đầu rồi check catalog y hệt.
     Không có booking nào → trả [] — response giống "session không tồn tại"
     nên không lộ gì. */
  async sessionBookings(
    sessionId: string,
    viewer: { sub: string; role?: string },
  ) {
    const bookings = await this.bookingRepository.findBySession(sessionId);
    if (bookings.length === 0) {
      return bookings;
    }
    const ownerId = await this.bookingRepository.eventOwnerOf(
      bookings[0].eventId,
    );
    if (ownerId !== viewer.sub && viewer.role !== 'ADMIN') {
      throw new NotFoundException('Session not found');
    }
    return bookings;
  }

  /* Chi tiết 1 booking: khách mua (userId == caller) HOẶC organizer của
     event (catalog) HOẶC admin. NOT_FOUND cho mọi case không có quyền để
     không lộ sự tồn tại của booking. */
  async booking(id: string, viewer: { sub: string; role?: string }) {
    const booking = await this.bookingRepository.findById(id);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.userId === viewer.sub || viewer.role === 'ADMIN') {
      return booking;
    }
    const ownerId = await this.bookingRepository.eventOwnerOf(booking.eventId);
    if (ownerId === viewer.sub) {
      return booking;
    }
    throw new NotFoundException('Booking not found');
  }

  myBookings(viewer: { sub: string }) {
    return this.bookingRepository.findByUser(viewer.sub);
  }

  // Vé đã bán (hold CONFIRMED) chỉ trả về kho sau khi refund xong — tránh
  // oversell nếu refund fail vĩnh viễn. Hold chưa confirm (RELEASED/EXPIRED)
  // thì revoke no-op nên gọi được cho mọi path refund.
  // ponytail: revoke fail chỉ log — ghế kẹt ở sold, conservative (không
  // oversell); ops query REFUNDED booking còn hold CONFIRMED để xử lý tay.
  private async revokeSoldHolds(
    bookingId: string,
    items?: { reservationId: string | null }[],
  ) {
    const booking = items
      ? { items }
      : await this.bookingRepository.findById(bookingId);
    if (!booking?.items.length) {
      return false;
    }

    let revoked = true;
    for (const item of booking.items) {
      if (!item.reservationId?.trim()) {
        revoked = false;
        this.logger.error(
          `reservation missing for booking ${bookingId}; inventory compensation remains pending`,
        );
        continue;
      }
      try {
        const result = await this.revokeInventory(item.reservationId, bookingId);
        if (!result.success) {
          revoked = false;
          this.logger.error(
            `revokeInventory ${item.reservationId} for booking ${bookingId} was not applied`,
          );
        }
      } catch (error: unknown) {
        revoked = false;
        this.logger.error(
          `revokeInventory ${item.reservationId} for booking ${bookingId} failed: ${String(error)}`,
        );
      }
    }
    return revoked;
  }

  private async finishRefundCompensation(
    bookingId: string,
    items: { reservationId: string | null }[],
    alreadyReleased = false,
  ) {
    const released =
      alreadyReleased || (await this.releaseBookingHolds(bookingId, items));
    if (released) {
      await this.bookingRepository.markInventoryReleased(bookingId);
    }
    const revoked = await this.revokeSoldHolds(bookingId, items);
    if (released && revoked) {
      await this.bookingRepository.clearInventoryCompensation(bookingId);
      return true;
    }
    return false;
  }
}
