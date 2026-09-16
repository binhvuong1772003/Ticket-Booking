import { Field, ID, InputType } from '@nestjs/graphql';
import { EventSessionStatus } from '@prisma/client';
import { IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

@InputType()
export class UpdateEventSessionStatusInput {
  @Field(() => ID)
  @IsMongoId()
  id!: string;

  @Field(() => EventSessionStatus)
  status!: EventSessionStatus;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancellationReason?: string | null;
}
