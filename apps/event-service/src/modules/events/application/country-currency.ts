// Map quốc gia → currency mặc định. Dùng khi input không khai báo currency
// rõ — currency của session vẫn có thể override bằng input.
import { normalizeCurrency } from './supported-currency';
const COUNTRY_CURRENCY: Record<string, string> = {
  VN: 'VND',
  US: 'USD',
  JP: 'JPY',
  KR: 'KRW',
  CN: 'CNY',
  HK: 'HKD',
  TW: 'TWD',
  SG: 'SGD',
  MY: 'MYR',
  TH: 'THB',
  ID: 'IDR',
  PH: 'PHP',
  IN: 'INR',
  AU: 'AUD',
  NZ: 'NZD',
  GB: 'GBP',
  CA: 'CAD',
  AE: 'AED',
  CH: 'CHF',
  AT: 'EUR',
  BE: 'EUR',
  DE: 'EUR',
  ES: 'EUR',
  FI: 'EUR',
  FR: 'EUR',
  GR: 'EUR',
  IE: 'EUR',
  IT: 'EUR',
  LU: 'EUR',
  NL: 'EUR',
  PT: 'EUR',
};

export function resolveSessionCurrency(
  currency?: string | null,
  countryCode?: string | null,
): string {
  const explicit = normalizeCurrency(currency);
  if (explicit) {
    return explicit;
  }
  return COUNTRY_CURRENCY[countryCode?.trim().toUpperCase() ?? ''] ?? 'USD';
}
