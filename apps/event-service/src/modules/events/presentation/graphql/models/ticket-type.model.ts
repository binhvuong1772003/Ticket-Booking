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

  @Field(() => TicketTypeStatus)
  status!: TicketTypeStatus;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;
}
