import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';

@Injectable()
export class EmailDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    dedupKey: string;
    bookingId: string;
    ownerId: string;
    recipientFullName?: string | null;
    recipientEmail?: string | null;
    ticketIds: string[];
    templateVersion: number;
    requireVerified?: boolean;
  }) {
    const row = await this.prisma.emailDelivery.upsert({
      where: { dedupKey: input.dedupKey },
      create: { ...input, requireVerified: input.requireVerified ?? false },
      update: {},
    });
    if (row.status === 'FAILED') {
      await this.prisma.emailDelivery.updateMany({
        where: { id: row.id, status: 'FAILED' },
        data: { status: 'QUEUED', lastErrorCode: null, attempts: 0 },
      });
    }
    return { ...row, status: row.status === 'FAILED' ? 'QUEUED' : row.status };
  }

  async reserveResend(ownerId: string, ticketId: string) {
    const now = new Date();
    try {
      await this.prisma.ticketEmailCooldown.create({
        data: { ownerId, ticketId, requestedAt: now },
      });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
    }
    const updated = await this.prisma.ticketEmailCooldown.updateMany({
      where: {
        ownerId,
        ticketId,
        requestedAt: { lte: new Date(now.getTime() - 60_000) },
      },
      data: { requestedAt: now },
    });
    return updated.count === 1;
  }

  async claim(id: string) {
    const now = new Date();
    const result = await this.prisma.emailDelivery.updateMany({
      where: {
        id,
        OR: [
          { status: 'QUEUED' },
          { status: 'SENDING', leaseUntil: { lte: now } },
        ],
      },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        leaseUntil: new Date(now.getTime() + 10 * 60_000),
      },
    });
    return result.count === 1;
  }

  get(id: string) {
    return this.prisma.emailDelivery.findUnique({ where: { id } });
  }

  async markSent(id: string, messageId: string) {
    await this.prisma.emailDelivery.updateMany({
      where: { id, status: 'SENDING' },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        messageId,
        leaseUntil: null,
        lastErrorCode: null,
      },
    });
  }

  async markFailure(id: string, errorCode: string, terminal: boolean) {
    await this.prisma.emailDelivery.updateMany({
      where: { id, status: 'SENDING' },
      data: {
        status: terminal ? 'FAILED' : 'QUEUED',
        leaseUntil: null,
        lastErrorCode: errorCode.slice(0, 120),
      },
    });
  }

  async recoverable() {
    const now = new Date();
    await this.prisma.emailDelivery.updateMany({
      where: { status: 'SENDING', leaseUntil: { lte: now } },
      data: { status: 'QUEUED', leaseUntil: null },
    });
    return this.prisma.emailDelivery.findMany({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true },
    });
  }
}
