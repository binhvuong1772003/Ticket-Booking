export type PaymentRefundedEvent = {
  eventId: string;
  eventType: 'payment.refunded';
  occurredAt: string;
  payload: {
    booking_id: string;
    user_id?: string;
    payment_intent_id?: string;
    refund_id?: string;
    amount?: number;
    currency?: string;
    reason?: string | null;
  };
};
