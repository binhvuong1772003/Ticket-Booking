import { Field, ID, InputType } from '@nestjs/graphql';
import {
  IsDate,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/* Allowlist duy nhất được sửa sau khi session đã SCHEDULED:
   giờ + địa điểm. name/capacity bị khóa — sửa chúng sau khi bán
   là thay đổi contract với người mua. */
@InputType()
export class RescheduleSessionInput {
  @Field(() => ID)
  @IsMongoId()
  id!: string;

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
}
