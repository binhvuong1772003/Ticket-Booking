import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class TicketBookingItemSnapshotModel {
  @Field(() => String, { nullable: true })
  unitPriceMinor!: string | null;

  @Field(() => String)
  unitPrice!: string;

  @Field(() => String)
  currency!: string;
}
