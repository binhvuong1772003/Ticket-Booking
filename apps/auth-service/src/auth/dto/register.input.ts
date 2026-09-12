import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

@InputType()
export class RegisterInput {
  @Field(() => String)
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email!: string;

  @Field(() => String)
  @IsString({ message: 'Password phải là chuỗi' })
  @MinLength(8, { message: 'Password tối thiểu 8 ký tự' })
  @MaxLength(72, { message: 'Password tối đa 72 ký tự' })
  password!: string;
}
