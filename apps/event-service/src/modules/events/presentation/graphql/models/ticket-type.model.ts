import {
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { TicketTypeStatus } from '@prisma/client';

registerEnumType(TicketTypeStatus, {
  name: 'TicketTypeStatus',
});

@ObjectType('TicketType')
export class TicketTypeModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  sessionId!: string;

  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => Int)
  price!: number;

  @Field(() => Int)
  quantity!: number;

  @Field(() => Int)
  sold!: number;

  @Field(() => Int, {
    nullable: true,
    description: 'Live best-effort quantity from inventory; booking rechecks atomically.',
  })
  availableQuantity?: number | null;

  @Field(() => Int, {
    nullable: true,
    description: 'Null when this ticket type has no per-booking limit.',
  })
  maxPerBooking?: number | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  salesStartAt?: Date | null;

  @Field(() => TicketTypeStatus)
  status!: TicketTypeStatus;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}
