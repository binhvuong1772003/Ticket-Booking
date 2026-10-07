import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('SupportedCurrency')
export class SupportedCurrencyModel {
  @Field()
  code!: string;

  @Field()
  name!: string;

  // 0 với zero-decimal currency (VND/JPY/KRW) — amount = giá nguyên,
  // không nhân 10^minorUnit.
  @Field(() => Int)
  minorUnit!: number;
}
