import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class BookingTrendingSaleModel {
  @Field(() => ID)
  eventId!: string;

  @Field(() => Int)
  confirmedQuantity!: number;

  @Field()
  cursor!: string;
}

@ObjectType()
export class BookingTrendingSalesPageInfoModel {
  @Field()
  hasNextPage!: boolean;

  @Field(() => String, { nullable: true })
  endCursor!: string | null;
}

@ObjectType()
export class BookingTrendingSalesConnectionModel {
  @Field(() => [BookingTrendingSaleModel])
  nodes!: BookingTrendingSaleModel[];

  @Field(() => BookingTrendingSalesPageInfoModel)
  pageInfo!: BookingTrendingSalesPageInfoModel;
}
