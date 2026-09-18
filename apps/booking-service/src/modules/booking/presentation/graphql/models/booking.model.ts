import {
  Field,
  Float,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';

export enum BookingStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PAID = 'PAID',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

registerEnumType(BookingStatus, { name: 'BookingStatus' });
registerEnumType(PaymentStatus, { name: 'PaymentStatus' });

@ObjectType('BookingItem')
export class BookingItemModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  bookingId!: string;

  @Field(() => ID)
  ticketTypeId!: string;

  @Field()
  ticketTypeName!: string;

  @Field()
  ticketTypeCode!: string;

  @Field(() => Int)
  quantity!: number;

  @Field(() => Float)
  unitPrice!: number;

  @Field(() => Float)
  subtotal!: number;

  @Field({ nullable: true })
  reservationId?: string;
}

@ObjectType('Booking')
export class BookingModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  userId!: string;

  @Field(() => ID)
  eventId!: string;

  @Field(() => ID)
  sessionId!: string;

  @Field(() => BookingStatus)
  status!: BookingStatus;

  @Field(() => PaymentStatus)
  paymentStatus!: PaymentStatus;

  @Field(() => Float)
  subtotal!: number;

  @Field(() => Float)
  discountAmount!: number;

  @Field(() => Float)
  feeAmount!: number;

  @Field(() => Float)
  totalAmount!: number;

  @Field()
  currency!: string;

  @Field({ nullable: true })
  paymentId?: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  expiresAt?: Date;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => [BookingItemModel])
  items!: BookingItemModel[];
}
