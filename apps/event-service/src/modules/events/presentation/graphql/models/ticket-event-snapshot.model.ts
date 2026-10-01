import {
  Field,
  GraphQLISODateTime,
  Int,
  ObjectType,
} from '@nestjs/graphql';

@ObjectType('TicketEventSnapshot')
export class TicketEventSnapshotModel {
  @Field()
  eventTitle!: string;

  @Field()
  eventStatus!: string;

  @Field(() => String, { nullable: true })
  coverImageUrl?: string | null;

  @Field(() => String, { nullable: true })
  posterImageUrl?: string | null;

  @Field(() => String, { nullable: true })
  venueName?: string | null;

  @Field(() => String, { nullable: true })
  venueAddress?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  startsAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  endsAt?: Date | null;

  @Field()
  timezone!: string;

  @Field(() => Int)
  sessionVersion!: number;

  @Field()
  sessionStatus!: string;
}
