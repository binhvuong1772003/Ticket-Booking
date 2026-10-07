import { Args, Query, Resolver } from '@nestjs/graphql';
import { getCountries, getPlaces } from '../../application/location-catalog';
import { CountryOptionModel, PlaceOptionModel } from './models/location-option.model';

@Resolver()
export class LocationResolver {
  @Query(() => [CountryOptionModel])
  countries() {
    return getCountries();
  }

  @Query(() => [PlaceOptionModel])
  places(@Args('countryCode') countryCode: string) {
    return getPlaces(countryCode);
  }
}
