import { Field, ObjectType } from '@nestjs/graphql';
import { EventSessionModel } from './event-session.model';
import { PageInfoModel } from './event-connection.model';

@ObjectType('EventSessionConnection')
export class EventSessionConnectionModel {
  @Field(() => [EventSessionModel])
  nodes!: EventSessionModel[];

  @Field(() => PageInfoModel)
  pageInfo!: PageInfoModel;
}
