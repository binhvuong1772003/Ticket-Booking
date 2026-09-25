import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PaymentService } from '../../application/payment.service';

type CreateCheckoutRequest = {
  booking_id: string;
  user_id?: string;
  amount: number;
  currency: string;
  organizer_account_id: string;
  quantity: number;
  ticket_type_name: string;
  success_url: string;
};

type RefundRequest = {
  booking_id: string;
  reason?: string;
};

@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @GrpcMethod('PaymentService', 'CreateCheckout')
  async createCheckout(input: CreateCheckoutRequest) {
    const session = await this.paymentService.createCheckout({
      bookingId: input.booking_id,
      userId: input.user_id,
      amount: input.amount,
      currency: input.currency,
      organizerAccountId: input.organizer_account_id,
      quantity: input.quantity,
      ticketTypeName: input.ticket_type_name,
      successUrl: input.success_url,
    });

    return {
      success: true,
      checkout_session_id: session.id,
      client_secret: session.client_secret,
      message: 'Checkout session created',
    };
  }

  @GrpcMethod('PaymentService', 'Refund')
  async refund(input: RefundRequest) {
    const result = await this.paymentService.refund({
      bookingId: input.booking_id,
      reason: input.reason,
    });
    return {
      accepted: result.accepted,
      refund_id: result.refundId,
      refunded: result.refunded,
    };
  }
}
