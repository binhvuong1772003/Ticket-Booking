import { Field, Int, ObjectType } from '@nestjs/graphql';
import { EventModel } from './event.model';

@ObjectType()
export class TrendingEventModel {
  @Field(() => Int)
  rank!: number;

  @Field(() => EventModel)
  event!: EventModel;
}
