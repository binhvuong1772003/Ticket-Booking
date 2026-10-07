import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType('BookingRecipient')
export class BookingRecipientModel {
  @Field(() => ID)
  bookingId!: string;

  @Field(() => ID)
  ownerId!: string;

  @Field(() => String, { nullable: true })
  recipientFullName?: string | null;

  @Field(() => String, { nullable: true })
  recipientEmail?: string | null;
}
