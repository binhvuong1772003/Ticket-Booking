import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function notificationEmailPayloadKey(
  value = process.env.NOTIFICATION_EMAIL_PAYLOAD_KEY,
): Buffer {
  if (!value || !/^[\da-f]{64}$/i.test(value)) {
    throw new Error(
      'NOTIFICATION_EMAIL_PAYLOAD_KEY must be exactly 64 hexadecimal characters',
    );
  }
  return Buffer.from(value, 'hex');
}

export function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptToken(value: string, key: Buffer): string {
  const [version, ivHex, tagHex, ciphertextHex, ...extra] = value.split(':');
  if (
    version !== 'v1' ||
    !ivHex ||
    !tagHex ||
    ciphertextHex === undefined ||
    extra.length
  ) {
    throw new Error('Unsupported notification email token ciphertext');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  if (
    iv.length !== 12 ||
    tag.length !== 16 ||
    !/^(?:[\da-f]{2})*$/i.test(ciphertextHex)
  ) {
    throw new Error('Invalid notification email token ciphertext');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}
