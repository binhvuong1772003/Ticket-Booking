import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class UserProfile {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  email!: string;

  @Field(() => String, { nullable: true })
  fullName!: string | null;

  @Field(() => String, { nullable: true })
  avatarUrl!: string | null;

  @Field(() => String)
  role!: string;
}
