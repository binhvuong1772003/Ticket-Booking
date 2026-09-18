import { Field, ID, InputType } from '@nestjs/graphql';
import {
  IsDate,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

@InputType()
export class UpdateEventSessionInput {
  @Field(() => ID)
  @IsMongoId()
  id!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  venueName?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  venueAddress?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Matches(/^[A-Z]{2}$/)
  countryCode?: string | null;

  @Field(() => Date, { nullable: true })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDate()
  startsAt?: Date | null;

  @Field(() => Date, { nullable: true })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsDate()
  endsAt?: Date | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  timezone?: string | null;

  @Field(() => Number, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number | null;
}
