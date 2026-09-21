import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PaymentService } from '../../application/payment.service';

type CreateCheckoutRequest = {
  booking_id: string;
  amount: number;
  currency: string;
  organizer_account_id: string;
  quantity: number;
  ticket_type_name: string;
  success_url: string;
};

@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @GrpcMethod('PaymentService', 'CreateCheckout')
  async createCheckout(input: CreateCheckoutRequest) {
    const session = await this.paymentService.createCheckout({
      bookingId: input.booking_id,
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
}
