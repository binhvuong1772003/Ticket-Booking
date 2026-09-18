import { Field, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

@InputType()
export class CreateTicketTypeInput {
  @Field(() => ID)
  @IsMongoId()
  sessionId!: string;

  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[A-Z0-9_-]+$/, {
    message: 'code must contain uppercase letters, numbers, _ or - only',
  })
  code!: string;

  @Field(() => Int)
  @IsInt()
  @Min(0)
  price!: number;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  quantity!: number;
}
