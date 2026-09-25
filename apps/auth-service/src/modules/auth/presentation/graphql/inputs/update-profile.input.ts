import { Field, InputType } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';

@InputType()
export class UpdateProfileInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  fullName?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'Avatar URL không hợp lệ' },
  )
  @Matches(/^https:\/\/res\.cloudinary\.com\//, {
    message: 'Avatar URL phải là Cloudinary URL',
  })
  @MaxLength(2048)
  avatarUrl?: string;
}
