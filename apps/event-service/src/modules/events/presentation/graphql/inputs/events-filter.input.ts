import { Field, GraphQLISODateTime, ID, InputType } from '@nestjs/graphql';
import {
  IsBoolean,
  IsDate,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

@InputType()
export class EventsFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  q?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  city?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/)
  countryCode?: string | null;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  placeId?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  startsAtFrom?: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  startsAtTo?: Date;

  @Field(() => Boolean, { defaultValue: false })
  @IsBoolean()
  upcomingOnly = false;
}
