import { ApiError } from '../../../common/errors/api-error';

export type PlaceType = 'CITY' | 'STATE';

export const LOCATION_CATALOG_VERSION = 2;

export interface CountryOption {
  code: string;
  nameVi: string;
  nameEn: string;
}

export interface PlaceOption {
  id: string;
  type: PlaceType;
  code: string;
  name: string;
  countryCode: string;
  aliases: readonly string[];
}

export const COUNTRIES: readonly CountryOption[] = Object.freeze([
  Object.freeze({ code: 'VN', nameVi: 'Việt Nam', nameEn: 'Vietnam' }),
  Object.freeze({ code: 'US', nameVi: 'Hoa Kỳ', nameEn: 'United States' }),
]);

const placeSeed: PlaceOption[] = [
  { id: 'VN-HANOI', type: 'CITY', code: 'HANOI', name: 'Hà Nội', countryCode: 'VN', aliases: ['Hanoi', 'Ha Noi', 'Thủ đô Hà Nội'] },
  { id: 'VN-HOCHIMINH', type: 'CITY', code: 'HOCHIMINH', name: 'TP. Hồ Chí Minh', countryCode: 'VN', aliases: ['TP.HCM', 'TP HCM', 'HCM', 'Sài Gòn', 'Saigon', 'Hồ Chí Minh', 'Ho Chi Minh', 'Ho Chi Minh City'] },
  { id: 'VN-DANANG', type: 'CITY', code: 'DANANG', name: 'Đà Nẵng', countryCode: 'VN', aliases: ['Da Nang'] },
  { id: 'VN-HAIPHONG', type: 'CITY', code: 'HAIPHONG', name: 'Hải Phòng', countryCode: 'VN', aliases: ['Hai Phong'] },
  { id: 'VN-CANTHO', type: 'CITY', code: 'CANTHO', name: 'Cần Thơ', countryCode: 'VN', aliases: ['Can Tho'] },
  { id: 'VN-HUE', type: 'CITY', code: 'HUE', name: 'Huế', countryCode: 'VN', aliases: ['Hue'] },
  { id: 'VN-NHATRANG', type: 'CITY', code: 'NHATRANG', name: 'Nha Trang', countryCode: 'VN', aliases: [] },
  { id: 'VN-DALAT', type: 'CITY', code: 'DALAT', name: 'Đà Lạt', countryCode: 'VN', aliases: ['Da Lat'] },
  { id: 'VN-OTHER', type: 'CITY', code: 'OTHER', name: 'Khác', countryCode: 'VN', aliases: [] },
  { id: 'US-CA', type: 'STATE', code: 'CA', name: 'California', countryCode: 'US', aliases: ['Calif.'] },
  { id: 'US-TX', type: 'STATE', code: 'TX', name: 'Texas', countryCode: 'US', aliases: [] },
  { id: 'US-FL', type: 'STATE', code: 'FL', name: 'Florida', countryCode: 'US', aliases: [] },
  { id: 'US-NY', type: 'STATE', code: 'NY', name: 'New York', countryCode: 'US', aliases: [] },
  { id: 'US-IL', type: 'STATE', code: 'IL', name: 'Illinois', countryCode: 'US', aliases: [] },
  { id: 'US-WA', type: 'STATE', code: 'WA', name: 'Washington', countryCode: 'US', aliases: [] },
  { id: 'US-MA', type: 'STATE', code: 'MA', name: 'Massachusetts', countryCode: 'US', aliases: ['Mass.'] },
  { id: 'US-PA', type: 'STATE', code: 'PA', name: 'Pennsylvania', countryCode: 'US', aliases: ['Penn.'] },
  { id: 'US-GA', type: 'STATE', code: 'GA', name: 'Georgia', countryCode: 'US', aliases: [] },
  { id: 'US-NJ', type: 'STATE', code: 'NJ', name: 'New Jersey', countryCode: 'US', aliases: [] },
  { id: 'US-OTHER', type: 'STATE', code: 'OTHER', name: 'Khác', countryCode: 'US', aliases: [] },
];

export const PLACES: readonly PlaceOption[] = Object.freeze(
  placeSeed.map((place) =>
    Object.freeze({ ...place, aliases: Object.freeze([...place.aliases]) }),
  ),
);

function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function getCountries(): readonly CountryOption[] {
  return COUNTRIES;
}

export function getPlaces(countryCode: string): readonly PlaceOption[] {
  const country = countryCode.trim().toUpperCase();
  if (!COUNTRIES.some(({ code }) => code === country)) {
    throw new ApiError(`Unsupported country: ${countryCode}`, 'BAD_USER_INPUT');
  }
  return PLACES.filter((place) => place.countryCode === country);
}

export function getPlace(id: string): PlaceOption | undefined {
  return PLACES.find((place) => place.id === id);
}

export function validatePlace(placeId: string, countryCode: string): PlaceOption {
  const place = getPlace(placeId);
  if (!place || place.countryCode !== countryCode.trim().toUpperCase()) {
    throw new ApiError('Unsupported place for country', 'BAD_USER_INPUT');
  }
  return place;
}

export function findPlaceByAlias(
  countryCode: string,
  name: string,
): PlaceOption | undefined {
  const alias = normalizeName(name);
  const matches = PLACES.filter(
    (place) =>
      place.countryCode === countryCode.trim().toUpperCase() &&
      place.code !== 'OTHER' &&
      [place.name, place.code, ...place.aliases].some(
        (candidate) => normalizeName(candidate) === alias,
      ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
