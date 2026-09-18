import { Field, Float, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

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

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  ticketTypeName!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  ticketTypeCode!: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  quantity!: number;

  @Field(() => Float)
  @Min(0)
  unitPrice!: number;

  @Field({ nullable: true, defaultValue: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;
}
