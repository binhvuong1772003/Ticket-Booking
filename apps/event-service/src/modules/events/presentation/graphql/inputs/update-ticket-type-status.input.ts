import { Field, ID, InputType } from '@nestjs/graphql';
import { IsEnum, IsMongoId } from 'class-validator';
import { TicketTypeStatus } from '@prisma/client';

@InputType()
export class UpdateTicketTypeStatusInput {
  @Field(() => ID)
  @IsMongoId()
  id!: string;

  // Chỉ ACTIVE | INACTIVE — SOLD_OUT bị service reject (trạng thái derive).
  @Field(() => TicketTypeStatus)
  @IsEnum(TicketTypeStatus)
  status!: TicketTypeStatus;
}
