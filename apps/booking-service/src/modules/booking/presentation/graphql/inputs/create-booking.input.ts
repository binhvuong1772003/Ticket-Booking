import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsMongoId, Min } from 'class-validator';

@InputType()
export class CreateBookingInput {
  @Field(() => ID)
  @IsMongoId()
  eventId!: string;

  @Field(() => ID)
  @IsMongoId()
  sessionId!: string;

  @Field(() => ID)
  @IsMongoId()
  ticketTypeId!: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  quantity!: number;
}
