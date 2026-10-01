import { ApiError } from '../../../common/errors/api-error';

export type SupportedCurrency = {
  code: string;
  name: string;
  // Đơn vị nhỏ nhất: VND/JPY/KRW là zero-decimal — amount gửi payment
  // platform không nhân 100 như USD/EUR.
  minorUnit: number;
};

// Currency mà payment layer chấp nhận cho charge. Session.currency và
// ticket_type.price đều đi theo list này — validate ở boundary.
export const SUPPORTED_CURRENCIES: readonly SupportedCurrency[] = [
  { code: 'USD', name: 'US Dollar', minorUnit: 2 },
  { code: 'VND', name: 'Vietnamese Dong', minorUnit: 0 },
  { code: 'EUR', name: 'Euro', minorUnit: 2 },
  { code: 'GBP', name: 'Pound Sterling', minorUnit: 2 },
  { code: 'JPY', name: 'Japanese Yen', minorUnit: 0 },
  { code: 'KRW', name: 'South Korean Won', minorUnit: 0 },
  { code: 'CNY', name: 'Chinese Yuan', minorUnit: 2 },
  { code: 'HKD', name: 'Hong Kong Dollar', minorUnit: 2 },
  { code: 'TWD', name: 'New Taiwan Dollar', minorUnit: 2 },
  { code: 'SGD', name: 'Singapore Dollar', minorUnit: 2 },
  { code: 'MYR', name: 'Malaysian Ringgit', minorUnit: 2 },
  { code: 'THB', name: 'Thai Baht', minorUnit: 2 },
  { code: 'IDR', name: 'Indonesian Rupiah', minorUnit: 2 },
  { code: 'PHP', name: 'Philippine Peso', minorUnit: 2 },
  { code: 'INR', name: 'Indian Rupee', minorUnit: 2 },
  { code: 'AUD', name: 'Australian Dollar', minorUnit: 2 },
  { code: 'NZD', name: 'New Zealand Dollar', minorUnit: 2 },
  { code: 'CAD', name: 'Canadian Dollar', minorUnit: 2 },
  { code: 'CHF', name: 'Swiss Franc', minorUnit: 2 },
  { code: 'AED', name: 'UAE Dirham', minorUnit: 2 },
];

// Chuẩn hoá + chặn currency ngoài list ngay tại boundary — trả undefined
// khi input trống để caller rơi về fallback (countryCode/USD).
export function normalizeCurrency(
  input: string | null | undefined,
): string | undefined {
  const code = input?.trim().toUpperCase();
  if (!code) {
    return undefined;
  }
  if (!SUPPORTED_CURRENCIES.some((c) => c.code === code)) {
    throw new ApiError(`Unsupported currency: ${code}`, 'BAD_USER_INPUT');
  }
  return code;
}
