import { Field, ID, InputType } from '@nestjs/graphql';
import {
  IsBoolean,
  IsMongoId,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

@InputType()
export class UpdateCategoryInput {
  @Field(() => ID)
  @IsMongoId()
  id!: string;

  @Field({ nullable: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @Field({ nullable: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;

  @Field(() => Boolean, { nullable: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
