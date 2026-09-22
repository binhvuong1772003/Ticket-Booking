import { Field, InputType } from '@nestjs/graphql';
import { IsString, MaxLength, MinLength } from 'class-validator';

@InputType()
export class ChangePasswordInput {
  @Field(() => String)
  @IsString({ message: 'Password phải là chuỗi' })
  currentPassword!: string;

  @Field(() => String)
  @IsString({ message: 'Password phải là chuỗi' })
  @MinLength(8, { message: 'Password tối thiểu 8 ký tự' })
  @MaxLength(72, { message: 'Password tối đa 72 ký tự' })
  newPassword!: string;
}
