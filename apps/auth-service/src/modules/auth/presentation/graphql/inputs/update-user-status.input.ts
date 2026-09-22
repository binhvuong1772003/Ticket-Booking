import { Field, ID, InputType, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsUUID } from 'class-validator';

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  BLOCKED = 'BLOCKED',
  PENDING = 'PENDING',
}

registerEnumType(UserStatus, {
  name: 'UserStatus',
});

@InputType()
export class UpdateUserStatusInput {
  @Field(() => ID)
  @IsUUID()
  userId!: string;

  @Field(() => UserStatus)
  @IsEnum(UserStatus)
  status!: UserStatus;
}
