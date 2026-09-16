import { Field, ID, InputType, registerEnumType } from '@nestjs/graphql';
import { EventStatus } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';

registerEnumType(EventStatus, {
  name: 'EventStatus',
});

@InputType()
export class UpdateEventStatusInput {
  @Field(() => ID)
  id!: string;

  @Field(() => EventStatus)
  status!: EventStatus;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  cancellationReason?: string | null;
}
