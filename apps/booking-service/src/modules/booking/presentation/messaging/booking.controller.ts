import { Controller, Inject, Logger } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import {
  BookingService,
  EventCancelledPayload,
  PaymentEventPayload,
  RefundRequestPayload,
} from '../../application/booking.service.js';

type PaymentEventEnvelope = {
  eventId: string;
  eventType: string;
  occurredAt: string;
  payload: PaymentEventPayload;
};

@Controller()
export class BookingController {
  private readonly logger = new Logger(BookingController.name);

  constructor(
    @Inject(BookingService) private readonly bookingService: BookingService,
  ) {}

  @MessagePattern('booking.health')
  getHealth() {
    return this.bookingService.getHealth();
  }

  // Handler-level catch: lỗi không ném ra ngoài để không block partition;
  // mọi state change đều conditional nên event gửi lại vẫn an toàn.
  @EventPattern('payment.succeeded')
  async onPaymentSucceeded(@Payload() event: PaymentEventEnvelope) {
    try {
      await this.bookingService.handlePaymentSucceeded(event.payload);
    } catch (error) {
      this.logger.error(`payment.succeeded handler failed: ${String(error)}`);
    }
  }

  @EventPattern('payment.expired')
  async onPaymentExpired(@Payload() event: PaymentEventEnvelope) {
    try {
      await this.bookingService.handlePaymentExpired(event.payload);
    } catch (error) {
      this.logger.error(`payment.expired handler failed: ${String(error)}`);
    }
  }

  @EventPattern('payment.failed')
  async onPaymentFailed(@Payload() event: PaymentEventEnvelope) {
    try {
      await this.bookingService.handlePaymentFailed(event.payload);
    } catch (error) {
      this.logger.error(`payment.failed handler failed: ${String(error)}`);
    }
  }

  @EventPattern('payment.refunded')
  async onPaymentRefunded(@Payload() event: PaymentEventEnvelope) {
    try {
      await this.bookingService.handlePaymentRefunded(event.payload);
    } catch (error) {
      this.logger.error(`payment.refunded handler failed: ${String(error)}`);
    }
  }

  @EventPattern('event.cancelled')
  async onEventCancelled(@Payload() event: { payload: EventCancelledPayload }) {
    try {
      await this.bookingService.handleEventCancelled(event.payload);
    } catch (error) {
      this.logger.error(`event.cancelled handler failed: ${String(error)}`);
    }
  }

  @EventPattern('booking.refund.requested')
  async onRefundRequested(@Payload() event: { payload: RefundRequestPayload }) {
    try {
      await this.bookingService.handleRefundRequest(event.payload);
    } catch (error) {
      this.logger.error(
        `booking.refund.requested handler failed: ${String(error)}`,
      );
    }
  }

  @EventPattern('event.published')
  async onEventPublished(
    @Payload() event: { payload: { event_id?: string; organizer_id?: string } },
  ) {
    try {
      await this.bookingService.handleEventPublished(event.payload);
    } catch (error) {
      this.logger.error(`event.published handler failed: ${String(error)}`);
    }
  }
}
