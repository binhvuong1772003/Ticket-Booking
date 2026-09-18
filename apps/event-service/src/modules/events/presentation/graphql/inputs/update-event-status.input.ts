import { Field, ID, InputType, registerEnumType } from '@nestjs/graphql';
import { EventStatus } from '@prisma/client';
import { IsEnum, IsMongoId, IsOptional, IsString } from 'class-validator';

registerEnumType(EventStatus, {
  name: 'EventStatus',
});

@InputType()
export class UpdateEventStatusInput {
  @Field(() => ID)
  @IsMongoId()
  id!: string;

  @Field(() => EventStatus)
  @IsEnum(EventStatus)
  status!: EventStatus;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  cancellationReason?: string | null;
}
