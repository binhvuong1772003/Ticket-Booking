import { Field, ID, InputType, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsUUID } from 'class-validator';

export enum AssignableUserRole {
  USER = 'USER',
  ORGANIZER = 'ORGANIZER',
}

registerEnumType(AssignableUserRole, {
  name: 'AssignableUserRole',
});

@InputType()
export class UpdateUserRoleInput {
  @Field(() => ID)
  @IsUUID()
  userId!: string;

  @Field(() => AssignableUserRole)
  @IsEnum(AssignableUserRole)
  role!: AssignableUserRole;
}
