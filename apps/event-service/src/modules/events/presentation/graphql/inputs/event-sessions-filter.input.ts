import { Field, GraphQLISODateTime, ID, InputType } from '@nestjs/graphql';
import { EventSessionStatus } from '@prisma/client';
import {
  IsDate,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

@InputType()
export class EventSessionsFilterInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
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

  @Field(() => EventSessionStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EventSessionStatus)
  status?: EventSessionStatus;
}
