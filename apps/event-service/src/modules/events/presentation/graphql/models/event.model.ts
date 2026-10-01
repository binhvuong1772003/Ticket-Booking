import {
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@nestjs/graphql';
import { EventSessionModel } from './event-session.model';

export enum EventAvailability {
  AVAILABLE = 'AVAILABLE',
  SOLD_OUT = 'SOLD_OUT',
  NOT_ON_SALE = 'NOT_ON_SALE',
  ENDED = 'ENDED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(EventAvailability, { name: 'EventAvailability' });

@ObjectType()
export class EventModel {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  slug!: string;

  @Field(() => ID, { nullable: true })
  categoryId?: string | null;

  @Field({ nullable: true })
  summary?: string;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  organizerDisplayName?: string;

  @Field({ nullable: true })
  contactEmail?: string;

  @Field({ nullable: true })
  contactPhone?: string;

  @Field({ nullable: true })
  coverImageUrl?: string;

  @Field(() => String, { nullable: true })
  posterImageUrl?: string | null;

  @Field()
  status!: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  publishedAt?: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  cancelledAt?: Date;

  @Field({ nullable: true })
  cancellationReason?: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  archivedAt?: Date;

  @Field(() => Int, { nullable: true })
  featuredOrder?: number | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => [EventSessionModel], { nullable: true })
  sessions?: EventSessionModel[];

  @Field(() => EventSessionModel, { nullable: true })
  nextSession?: EventSessionModel | null;

  @Field(() => Int, { nullable: true })
  priceFrom?: number | null;

  @Field(() => String, { nullable: true })
  currency?: string | null;

  @Field(() => EventAvailability, { nullable: true })
  availability?: EventAvailability | null;
}
