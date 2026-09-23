import {
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { EventSessionStatus } from '@prisma/client';
import { TicketTypeModel } from './ticket-type.model';

registerEnumType(EventSessionStatus, {
  name: 'EventSessionStatus',
});

@ObjectType('EventSession')
export class EventSessionModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  eventId!: string;

  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  venueName?: string;

  @Field({ nullable: true })
  venueAddress?: string;

  @Field({ nullable: true })
  city?: string;

  @Field({ nullable: true })
  countryCode?: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  startsAt?: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  endsAt?: Date;

  @Field()
  timezone!: string;

  @Field(() => Int, { nullable: true })
  capacity?: number;

  @Field(() => EventSessionStatus)
  status!: EventSessionStatus;

  @Field(() => GraphQLISODateTime, { nullable: true })
  cancelledAt?: Date;

  @Field({ nullable: true })
  cancellationReason?: string;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => [TicketTypeModel], { nullable: true })
  ticketTypes?: TicketTypeModel[];
}
