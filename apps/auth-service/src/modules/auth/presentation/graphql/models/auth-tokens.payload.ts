import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class AuthTokensPayload {
  @Field(() => String)
  accessToken!: string;
}
