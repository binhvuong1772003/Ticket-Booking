import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import { EventSessionModel } from './event-session.model';

@ObjectType()
export class EventModel {
  @Field(() => ID)
  id!: string;

  @Field()
  title!: string;

  @Field()
  slug!: string;

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

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => [EventSessionModel], { nullable: true })
  sessions?: EventSessionModel[];
}
