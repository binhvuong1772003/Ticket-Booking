import { Field, InputType } from '@nestjs/graphql';
import {
  IsEmail,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

@InputType()
export class UpdateEventInput {
  @Field(() => String)
  @IsMongoId()
  id!: string;

  @Field(() => String, { nullable: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  title?: string;

  @Field(() => String, { nullable: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must contain lowercase letters, numbers and hyphens only',
  })
  slug?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  summary?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  organizerDisplayName?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsEmail()
  contactEmail?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Matches(/^\+?[0-9\s().-]{7,20}$/, {
    message: 'Invalid phone number',
  })
  contactPhone?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'Cover image URL không hợp lệ' },
  )
  @Matches(/^https:\/\/res\.cloudinary\.com\//, {
    message: 'Cover image URL phải là Cloudinary URL',
  })
  @MaxLength(2048)
  coverImageUrl?: string | null;
}
