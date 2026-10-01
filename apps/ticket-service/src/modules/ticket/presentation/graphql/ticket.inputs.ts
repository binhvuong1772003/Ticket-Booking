import { Field, ID, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

@InputType()
export class TicketCheckInInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  qrToken!: string;

  @Field(() => ID)
  @IsUUID()
  requestId!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  gateId?: string | null;
}
