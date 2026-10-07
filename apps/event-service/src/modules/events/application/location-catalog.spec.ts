import { describe, expect, it } from 'vitest';
import {
  findPlaceByAlias,
  getCountries,
  getPlace,
  getPlaces,
  LOCATION_CATALOG_VERSION,
  PLACES,
  validatePlace,
} from './location-catalog';
import { LocationResolver } from '../presentation/graphql/location.resolver';

describe('location catalog', () => {
  it('contains two countries and twenty correctly typed places', () => {
    expect(getCountries().map(({ code }) => code)).toEqual(['VN', 'US']);
    expect(LOCATION_CATALOG_VERSION).toBe(2);
    expect(PLACES).toHaveLength(20);
    expect(getPlaces('VN')).toHaveLength(9);
    expect(getPlaces('VN').every(({ type, countryCode }) => type === 'CITY' && countryCode === 'VN')).toBe(true);
    expect(getPlaces('US')).toHaveLength(11);
    expect(getPlaces('US').every(({ type, countryCode }) => type === 'STATE' && countryCode === 'US')).toBe(true);
    expect(getPlace('VN-OTHER')).toMatchObject({ type: 'CITY', countryCode: 'VN' });
    expect(getPlace('US-OTHER')).toMatchObject({ type: 'STATE', countryCode: 'US' });
    expect(validatePlace('VN-OTHER', 'VN').id).toBe('VN-OTHER');
    expect(validatePlace('US-OTHER', 'US').id).toBe('US-OTHER');
    expect(() => getPlaces('CA')).toThrow(expect.objectContaining({ extensions: { code: 'BAD_USER_INPUT' } }));
  });

  it('resolves Vietnamese aliases uniquely and rejects unknown or cross-country IDs', () => {
    for (const alias of ['TP.HCM', 'Hồ Chí Minh', 'Ho Chi Minh']) {
      expect(findPlaceByAlias('VN', alias)?.id).toBe('VN-HOCHIMINH');
    }
    expect(findPlaceByAlias('VN', 'no such place')).toBeUndefined();
    expect(findPlaceByAlias('VN', 'Khác')).toBeUndefined();
    expect(findPlaceByAlias('VN', 'Other')).toBeUndefined();
    expect(findPlaceByAlias('US', 'Khác')).toBeUndefined();
    expect(findPlaceByAlias('US', 'Other')).toBeUndefined();
    expect(getPlace('made-up')).toBeUndefined();
    expect(() => validatePlace('made-up', 'VN')).toThrow(expect.objectContaining({ extensions: { code: 'BAD_USER_INPUT' } }));
    expect(() => validatePlace('US-CA', 'VN')).toThrow(expect.objectContaining({ extensions: { code: 'BAD_USER_INPUT' } }));
  });

  it('serves the public country and place queries', () => {
    const resolver = new LocationResolver();
    expect(resolver.countries()).toEqual(getCountries());
    const usPlaces = resolver.places('US');
    expect(usPlaces).toHaveLength(11);
    expect(usPlaces.every(({ countryCode, type }) => countryCode === 'US' && type === 'STATE')).toBe(true);
    expect(() => resolver.places('CA')).toThrow(
      expect.objectContaining({ extensions: { code: 'BAD_USER_INPUT' } }),
    );
  });
});
