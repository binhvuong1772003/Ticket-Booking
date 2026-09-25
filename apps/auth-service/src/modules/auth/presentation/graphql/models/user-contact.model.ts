import { Field, ObjectType } from '@nestjs/graphql';

// Trường tối thiểu cho tra cứu nội bộ service-to-service — không trả
// role/avatar để giảm bề mặt PII.
@ObjectType()
export class UserContact {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  email!: string;

  @Field(() => String, { nullable: true })
  fullName!: string | null;
}
