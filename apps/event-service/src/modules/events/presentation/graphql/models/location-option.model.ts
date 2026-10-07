import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum PlaceType {
  CITY = 'CITY',
  STATE = 'STATE',
}

registerEnumType(PlaceType, { name: 'PlaceType' });

@ObjectType('CountryOption')
export class CountryOptionModel {
  @Field()
  code!: string;

  @Field()
  nameVi!: string;

  @Field()
  nameEn!: string;
}

@ObjectType('PlaceOption')
export class PlaceOptionModel {
  @Field(() => ID)
  id!: string;

  @Field(() => PlaceType)
  type!: PlaceType;

  @Field()
  code!: string;

  @Field()
  name!: string;

  @Field()
  countryCode!: string;

  @Field(() => [String])
  aliases!: string[];
}
