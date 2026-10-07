import { describe, expect, it } from 'vitest';
import {
  decryptToken,
  encryptToken,
  notificationEmailPayloadKey,
} from './notification-email-crypto';

describe('notification email token crypto', () => {
  it('round trips tokens with versioned randomized authenticated ciphertext', () => {
    const key = notificationEmailPayloadKey('ab'.repeat(32));
    const first = encryptToken('verification-secret', key);
    const second = encryptToken('verification-secret', key);
    expect(first).toMatch(/^v1:/);
    expect(first).not.toBe(second);
    expect(decryptToken(first, key)).toBe('verification-secret');
    expect(() =>
      decryptToken(first, notificationEmailPayloadKey('cd'.repeat(32))),
    ).toThrow();
  });

  it('rejects missing or malformed payload keys', () => {
    const currentKey = process.env.NOTIFICATION_EMAIL_PAYLOAD_KEY;
    delete process.env.NOTIFICATION_EMAIL_PAYLOAD_KEY;
    try {
      expect(() => notificationEmailPayloadKey()).toThrow();
    } finally {
      if (currentKey === undefined)
        delete process.env.NOTIFICATION_EMAIL_PAYLOAD_KEY;
      else process.env.NOTIFICATION_EMAIL_PAYLOAD_KEY = currentKey;
    }
    expect(() => notificationEmailPayloadKey('short')).toThrow();
  });
});
