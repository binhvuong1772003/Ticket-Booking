import { Field, ObjectType } from '@nestjs/graphql';
import { EventModel } from './event.model';

@ObjectType('PageInfo')
export class PageInfoModel {
  @Field()
  hasNextPage!: boolean;

  @Field({ nullable: true })
  endCursor?: string;
}

@ObjectType('EventConnection')
export class EventConnectionModel {
  @Field(() => [EventModel])
  nodes!: EventModel[];

  @Field(() => PageInfoModel)
  pageInfo!: PageInfoModel;
}
