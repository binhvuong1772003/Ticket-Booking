import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
      }),
    );
  }

  private revokeInventory(reservationId: string, bookingId: string) {
    return firstValueFrom(
      this.inventoryService.revoke({
        reservation_id: reservationId,
        booking_id: bookingId,
      }),
    );
  }

  private refundPayment(bookingId: string, reason: string) {
    return firstValueFrom(
      this.paymentService.refund({ booking_id: bookingId, reason }),
    );
  }

  async handlePaymentSucceeded(payload: PaymentEventPayload) {
    const bookingId = payload.booking_id;
    if (!bookingId) {
      this.logger.warn('payment.succeeded without booking_id, skipped');
      return;
    }

    const { count } = await this.bookingRepository.confirmPaid(bookingId);
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      this.logger.warn(`payment.succeeded for unknown booking ${bookingId}`);
      return;
    }

    // CONFIRMED cũng chạy lại confirm: heal cho crash giữa confirmPaid và
    // confirmInventory — Confirm idempotent nên gọi lại an toàn.
    if (count === 1 || booking.status === 'CONFIRMED') {
      for (const item of booking.items) {
        if (!item.reservationId) {
          continue;
        }
        const confirmed = await this.confirmInventory(
          item.reservationId,
          bookingId,
        )
          .then((res) => res.success)
          // ponytail: lỗi transport khi confirm coi như fail → refund.
          // Nếu server đã confirm nhưng mất response, sold lệch — đối soát tay.
          .catch((error: unknown) => {
            this.logger.error(
              `confirmInventory ${item.reservationId} failed: ${String(error)}`,
            );
            return false;
          });
        if (!confirmed) {
          await this.refundAndCancel(
            bookingId,
            'Hold no longer active after payment',
          );
          return;
        }
      }
      return;
    }

    if (booking.paymentStatus === 'REFUNDED') {
      return;
    }
    // Tiền đã thu sau khi booking đóng (EXPIRED/CANCELLED) — không thể confirm
    // vì hold đã trả, re-confirm sẽ oversell → refund.
    await this.refundAndCancel(bookingId, 'Paid after booking closed');
  }

  async handlePaymentExpired(payload: PaymentEventPayload) {
    const bookingId = payload.booking_id;
    if (!bookingId) {
      this.logger.warn('payment.expired without booking_id, skipped');
      return;
    }

    const { count } = await this.bookingRepository.expireIfPending(bookingId);
    if (count !== 1) {
      return;
    }
    await this.releaseBookingHolds(bookingId);
  }

  async handlePaymentFailed(payload: PaymentEventPayload) {
    const bookingId = payload.booking_id;
    if (!bookingId) {
      this.logger.warn('payment.failed without booking_id, skipped');
      return;
    }

    // Giữ PENDING: embedded checkout cho retry; hết expiresAt sweeper dọn.
    await this.bookingRepository.markPaymentFailed(bookingId);
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
      await this.releaseBookingHolds(booking.id, booking.items);
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
    for (const item of booking?.items ?? []) {
      if (!item.reservationId) {
        continue;
      }
      await this.releaseInventory(item.reservationId, bookingId).catch(
        (error: unknown) => {
          this.logger.error(
            `releaseInventory ${item.reservationId} for booking ${bookingId} failed: ${String(error)}`,
          );
        },
      );
    }
  }

  async handlePaymentRefunded(payload: PaymentEventPayload) {
    const bookingId = payload.booking_id;
    if (!bookingId) {
      this.logger.warn('payment.refunded without booking_id, skipped');
      return;
    }

    const { count } = await this.bookingRepository.markRefunded(bookingId);
    if (count !== 1) {
      return;
    }
    await this.revokeSoldHolds(bookingId);
  }

  // Organizer chủ động refund vé lẻ — lệnh từ event-service (đã verify
  // ownership phía đó). Ở đây verify binding booking↔event rồi mới refund.
  async handleRefundRequest(payload: RefundRequestPayload) {
    const bookingId = payload.booking_id;
    if (!bookingId) {
      this.logger.warn('booking.refund.requested without booking_id');
      return;
    }

    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      this.logger.warn(`refund request for unknown booking ${bookingId}`);
      return;
    }
    if (booking.eventId !== payload.event_id) {
      this.logger.warn(
        `refund request event mismatch for booking ${bookingId}, rejected`,
      );
      return;
    }
    // Chỉ refund vé đã bán (CONFIRMED + PAID). PENDING chưa thu tiền — không
    // có gì để hoàn; REFUNDING/REFUNDED nghĩa là request trước đã xử lý.
    if (booking.status !== 'CONFIRMED' || booking.paymentStatus !== 'PAID') {
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

  // ponytail: fan-out quét 1 lần tối đa `take` booking/event — event hàng
  // nghìn vé cần paging/queue riêng; Redelivery Kafka chạy lại idempotent.
  async handleEventCancelled(payload: EventCancelledPayload, take = 500) {
    const eventId = payload.event_id;
    if (!eventId) {
      this.logger.warn('event.cancelled without event_id, skipped');
      return;
    }
    const reason = payload.reason ?? 'Event cancelled';

    const bookings = await this.bookingRepository.findActiveByEvent(
      eventId,
      take,
    );
    for (const booking of bookings) {
      if (booking.status === 'PENDING') {
        const { count } = await this.bookingRepository.cancelIfPending(
          booking.id,
          reason,
        );
        if (count === 1) {
          await this.releaseBookingHolds(booking.id, booking.items);
        }
        continue;
      }
      // CONFIRMED: vé đã bán → refund. PAID mới là tiền đã thu.
      if (booking.paymentStatus === 'PAID') {
        await this.refundAndCancel(booking.id, reason);
      } else {
        await this.bookingRepository.cancelUnlessCancelled(booking.id, reason);
      }
    }
    return bookings.length;
  }

  // Booking đã đóng nhưng PAID = refund request chưa đến được payment-service
  // (gRPC fail lúc handlePaymentSucceeded). Refund RPC idempotent nên gọi lại
  // mỗi vòng sweep an toàn; khi refund xong thì payment.refunded mark REFUNDED
  // và booking tự rơi khỏi query này.
  async sweepStuckRefunds(take: number) {
    const stuck = await this.bookingRepository.findTerminalPaid(take);
    for (const booking of stuck) {
      await this.refundAndCancel(booking.id, 'Paid after booking closed');
    }
    return stuck.length;
  }

  // Refund là async: payment-service ghi intent rồi trả accepted, Stripe chạy
  // sau qua BullMQ. Booking cancel ngay, paymentStatus PAID → REFUNDING
  // ("refund in-flight") cho tới khi event payment.refunded đến; request fail
  // trước khi intent được ghi thì booking giữ PAID và sweepStuckRefunds retry.
  private async refundAndCancel(bookingId: string, reason: string) {
    await this.bookingRepository.markPaid(bookingId);
    let result: RefundResponse;
    try {
      result = await this.refundPayment(bookingId, reason);
    } catch (error) {
      this.logger.error(
        `refund request for booking ${bookingId} failed: ${String(error)}`,
      );
      return;
    }
    await this.bookingRepository.cancelUnlessCancelled(bookingId, reason);
    if (result.refunded) {
      await this.bookingRepository.markRefunded(bookingId);
      await this.revokeSoldHolds(bookingId);
      return;
    }
    await this.bookingRepository.markRefunding(bookingId);
  }

  /* event.published → EventCatalog projection (eventId → organizerId).
     Bookings chỉ tồn tại sau khi event PUBLISHED (session chỉ schedule
     được trên event published) nên catalog luôn có trước booking đầu tiên. */
  async handleEventPublished(payload: {
    event_id?: string;
    organizer_id?: string;
  }) {
    if (!payload.event_id || !payload.organizer_id) {
      this.logger.warn(
        `event.published thiếu field: ${JSON.stringify(payload)}`,
      );
      return;
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
    for (const item of booking?.items ?? []) {
      if (!item.reservationId) {
        continue;
      }
      await this.revokeInventory(item.reservationId, bookingId).catch(
        (error: unknown) => {
          this.logger.error(
            `revokeInventory ${item.reservationId} for booking ${bookingId} failed: ${String(error)}`,
          );
        },
      );
    }
  }
}
