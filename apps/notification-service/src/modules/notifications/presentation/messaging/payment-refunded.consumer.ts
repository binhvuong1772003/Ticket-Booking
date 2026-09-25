import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { PaymentRefundedEvent } from '../../../../../../../libs/contracts/src/events/payment/payment-refunded.event';
import { PaymentRefundedEmailHandler } from '../../application/handlers/payment-refunded.handler.js';

@Controller()
export class PaymentRefundedConsumer {
  constructor(
    private readonly paymentRefundedEmailHandler: PaymentRefundedEmailHandler,
  ) {}

  @EventPattern('payment.refunded')
  handlePaymentRefunded(@Payload() event: PaymentRefundedEvent) {
    return this.paymentRefundedEmailHandler.handlePaymentRefunded(event);
  }
}
