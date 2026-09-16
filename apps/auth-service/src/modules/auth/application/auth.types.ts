export type UserRole = 'USER' | 'ADMIN';

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

export type TokenMeta = {
  deviceInfo?: string;
  ipAddress?: string;
};
