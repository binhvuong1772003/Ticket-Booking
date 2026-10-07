import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class MyTicketSummary {
  @Field(() => ID) ticketId!: string;
  @Field(() => ID) bookingId!: string;
  @Field(() => Int) ordinal!: number;
  @Field() status!: string;
  @Field() issuedAt!: string;
  @Field(() => String, { nullable: true }) eventTitle!: string | null;
  @Field(() => String, { nullable: true }) startsAt!: string | null;
  @Field(() => String, { nullable: true }) endsAt!: string | null;
  @Field(() => String, { nullable: true }) timezone!: string | null;
  @Field(() => String, { nullable: true }) ticketTypeName!: string | null;
  @Field(() => String, { nullable: true }) ticketTypeCode!: string | null;
}

@ObjectType()
export class MyTicketDetail extends MyTicketSummary {
  @Field(() => String, { nullable: true }) posterImageUrl!: string | null;
  @Field(() => String, { nullable: true }) coverImageUrl!: string | null;
  @Field(() => String, { nullable: true }) venueName!: string | null;
  @Field(() => String, { nullable: true }) venueAddress!: string | null;
  @Field(() => String, { nullable: true }) unitPrice!: string | null;
  @Field(() => String, { nullable: true }) currency!: string | null;
  @Field(() => Int) templateVersion!: number;
  @Field(() => Int) renderRevision!: number;
  @Field(() => String, { nullable: true }) qrToken!: string | null;
}

@ObjectType()
export class MyTicketPage {
  @Field(() => [MyTicketSummary]) items!: MyTicketSummary[];
  @Field(() => String, { nullable: true }) nextCursor!: string | null;
}

@ObjectType()
export class TicketEmailResendPayload {
  @Field(() => ID) deliveryId!: string;
  @Field() status!: string;
}

@ObjectType()
export class TicketCheckInPayload {
  @Field() result!: string;
  @Field(() => ID, { nullable: true }) ticketId!: string | null;
}
