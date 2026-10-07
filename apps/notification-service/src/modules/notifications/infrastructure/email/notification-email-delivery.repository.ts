import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import {
  decryptToken,
  encryptToken,
  notificationEmailPayloadKey,
} from './notification-email-crypto';

export type NotificationEmailDeliveryKind = 'VERIFICATION' | 'REFUND';
export type NotificationEmailDeliveryStatus =
  'QUEUED' | 'SENDING' | 'SENT' | 'FAILED';
export type VerificationPayload = { to: string; verificationToken: string };
export type RefundPayload = {
  bookingId: string;
  userId: string;
  amount: number | null;
  currency: string | null;
};
export type NotificationEmailDeliveryWithDecryptedPayload = {
  id: string;
  kind: NotificationEmailDeliveryKind;
  payload: VerificationPayload | RefundPayload;
  attempts: number;
  expiresAt: Date | null;
};
type StoredPayload =
  { to: string; verificationTokenCiphertext: string } | RefundPayload;
const MAX_ATTEMPTS = 5;

function deliveryStatus(value: string): NotificationEmailDeliveryStatus {
  if (
    value === 'QUEUED' ||
    value === 'SENDING' ||
    value === 'SENT' ||
    value === 'FAILED'
  )
    return value;
  throw new Error(`Invalid notification email delivery status: ${value}`);
}

function deliveryKind(value: string): NotificationEmailDeliveryKind {
  if (value === 'VERIFICATION' || value === 'REFUND') return value;
  throw new Error(`Invalid notification email delivery kind: ${value}`);
}

function deliveryPayload(
  kind: NotificationEmailDeliveryKind,
  value: unknown,
  key: Buffer,
): VerificationPayload | RefundPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid notification email payload');
  const payload = value as Record<string, unknown>;
  if (kind === 'VERIFICATION') {
    if (
      typeof payload.to !== 'string' ||
      typeof payload.verificationTokenCiphertext !== 'string'
    ) {
      throw new Error('Invalid verification email payload');
    }
    return {
      to: payload.to,
      verificationToken: decryptToken(payload.verificationTokenCiphertext, key),
    };
  }
  if (
    typeof payload.bookingId !== 'string' ||
    typeof payload.userId !== 'string' ||
    (payload.amount !== null && typeof payload.amount !== 'number') ||
    (payload.currency !== null && typeof payload.currency !== 'string')
  )
    throw new Error('Invalid refund email payload');
  return {
    bookingId: payload.bookingId,
    userId: payload.userId,
    amount: payload.amount,
    currency: payload.currency,
  };
}

@Injectable()
export class NotificationEmailDeliveryRepository {
  private readonly key = notificationEmailPayloadKey();

  constructor(private readonly prisma: PrismaService) {}

  async createOrGet(input: {
    kind: NotificationEmailDeliveryKind;
    eventId: string;
    payload: VerificationPayload | RefundPayload;
    expiresAt?: Date;
  }): Promise<{ id: string; status: NotificationEmailDeliveryStatus }> {
    const dedupKey = `${input.kind.toLowerCase()}:${input.eventId}`;
    const existing = await this.prisma.notificationEmailDelivery.findUnique({
      where: { dedupKey },
    });
    if (existing) {
      deliveryKind(existing.kind);
      return { id: existing.id, status: deliveryStatus(existing.status) };
    }
    const payload: StoredPayload =
      input.kind === 'VERIFICATION'
        ? {
            to: (input.payload as VerificationPayload).to,
            verificationTokenCiphertext: encryptToken(
              (input.payload as VerificationPayload).verificationToken,
              this.key,
            ),
          }
        : (input.payload as RefundPayload);
    try {
      const row = await this.prisma.notificationEmailDelivery.upsert({
        where: { dedupKey },
        create: {
          dedupKey,
          kind: input.kind,
          payload,
          expiresAt: input.expiresAt ?? null,
        },
        update: {},
      });
      deliveryKind(row.kind);
      return { id: row.id, status: deliveryStatus(row.status) };
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      const row = await this.prisma.notificationEmailDelivery.findUnique({
        where: { dedupKey },
      });
      if (!row) throw error;
      deliveryKind(row.kind);
      return { id: row.id, status: deliveryStatus(row.status) };
    }
  }

  async claim(id: string): Promise<{
    delivery: NotificationEmailDeliveryWithDecryptedPayload;
    leaseId: string;
  } | null> {
    const now = new Date();
    const eligible = {
      id,
      OR: [
        { status: 'QUEUED' },
        { status: 'SENDING', leaseUntil: { lte: now } },
      ],
    };
    await this.prisma.notificationEmailDelivery.updateMany({
      where: { ...eligible, attempts: { gte: MAX_ATTEMPTS } },
      data: {
        status: 'FAILED',
        payload: null,
        leaseId: null,
        leaseUntil: null,
        lastErrorCode: 'ATTEMPTS_EXHAUSTED',
      },
    });
    const leaseId = randomUUID();
    const claimed = await this.prisma.notificationEmailDelivery.updateMany({
      where: { ...eligible, attempts: { lt: MAX_ATTEMPTS } },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        leaseId,
        leaseUntil: new Date(now.getTime() + 10 * 60_000),
      },
    });
    if (claimed.count !== 1) return null;
    const row = await this.prisma.notificationEmailDelivery.findUnique({
      where: { id },
    });
    if (!row || row.status !== 'SENDING' || row.leaseId !== leaseId)
      return null;
    if (!row.payload) {
      await this.markFailure(id, leaseId, 'PAYLOAD_MISSING', true);
      return null;
    }
    try {
      const kind = deliveryKind(row.kind);
      const decrypted = deliveryPayload(kind, row.payload, this.key);
      return {
        delivery: {
          id: row.id,
          kind,
          payload: decrypted,
          attempts: row.attempts,
          expiresAt: row.expiresAt,
        },
        leaseId,
      };
    } catch {
      await this.markFailure(
        id,
        leaseId,
        'PAYLOAD_INVALID',
        row.attempts >= MAX_ATTEMPTS,
      );
      return null;
    }
  }

  async markSent(
    id: string,
    leaseId: string,
    messageId: string,
  ): Promise<boolean> {
    const result = await this.prisma.notificationEmailDelivery.updateMany({
      where: { id, status: 'SENDING', leaseId },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        messageId,
        leaseId: null,
        leaseUntil: null,
        lastErrorCode: null,
        payload: null,
      },
    });
    return result.count === 1;
  }

  async markFailure(
    id: string,
    leaseId: string,
    errorCode: string,
    terminal: boolean,
  ): Promise<boolean> {
    const result = await this.prisma.notificationEmailDelivery.updateMany({
      where: { id, status: 'SENDING', leaseId },
      data: {
        status: terminal ? 'FAILED' : 'QUEUED',
        leaseId: null,
        leaseUntil: null,
        lastErrorCode: errorCode.slice(0, 120),
        ...(terminal ? { payload: null } : {}),
      },
    });
    return result.count === 1;
  }

  async recoverable(take: number): Promise<Array<{ id: string }>> {
    const now = new Date();
    return this.prisma.notificationEmailDelivery.findMany({
      where: {
        OR: [
          { status: 'QUEUED' },
          { status: 'SENDING', leaseUntil: { lte: now } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take,
      select: { id: true },
    });
  }
}
