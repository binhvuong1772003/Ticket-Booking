import { Field, ID, InputType, Int } from '@nestjs/graphql';
import {
  IsISO8601,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
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

  @Field({ nullable: true, defaultValue: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  quantity!: number;

  @Field(() => String, {
    nullable: true,
    description:
      'Opening time: ISO 8601 timestamp with Z or an explicit timezone offset.',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
    {
      message:
        'salesStartAt must include a date, time and timezone (Z or +/-HH:mm)',
    },
  )
  salesStartAt?: string | null;
}
