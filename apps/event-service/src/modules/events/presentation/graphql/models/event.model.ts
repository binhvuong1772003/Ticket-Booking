import { Field, ID, ObjectType } from '@nestjs/graphql';

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
  organizerDisplayName?: string;

  @Field({ nullable: true })
  contactEmail?: string;

  @Field({ nullable: true })
  contactPhone?: string;

  @Field()
  status!: string;
}
