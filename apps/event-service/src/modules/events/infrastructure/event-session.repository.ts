import { Injectable } from '@nestjs/common';
import { EventSessionStatus } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ApiError } from '../../../common/errors/api-error';

export type CreateEventSessionData = {
  eventId: string;
  name?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  countryCode?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  capacity?: number | null;
};

export type UpdateEventSessionData = {
  id: string;
  ownerId: string;
  name?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  countryCode?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  capacity?: number | null;
};

@Injectable()
export class EventsSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateEventSessionData) {
    try {
      return await this.prisma.eventSession.create({
        data: {
          eventId: data.eventId,
          name: data.name,
          venueName: data.venueName,
          venueAddress: data.venueAddress,
          city: data.city,
          countryCode: data.countryCode,
          startsAt: data.startsAt,
          endsAt: data.endsAt,
          timezone: data.timezone ?? undefined,
          capacity: data.capacity,
        },
      });
    } catch (error: unknown) {
      throw new ApiError(
        'Failed to create event session',
        'INTERNAL_SERVER_ERROR',
      );
    }
  }

  findByIdAndOwner(id: string, ownerId: string) {
    return this.prisma.eventSession.findFirst({
      where: {
        id,
        event: { ownerId },
      },
    });
  }

  async update(data: UpdateEventSessionData) {
    const session = await this.findByIdAndOwner(data.id, data.ownerId);

    if (!session) {
      throw new ApiError('Event session not found', 'NOT_FOUND');
    }

    const result = await this.prisma.eventSession.updateMany({
      where: { id: data.id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.venueName !== undefined && { venueName: data.venueName }),
        ...(data.venueAddress !== undefined && {
          venueAddress: data.venueAddress,
        }),
        ...(data.city !== undefined && { city: data.city }),
        ...(data.countryCode !== undefined && {
          countryCode: data.countryCode,
        }),
        ...(data.startsAt !== undefined && { startsAt: data.startsAt }),
        ...(data.endsAt !== undefined && { endsAt: data.endsAt }),
        ...(data.timezone !== undefined && {
          timezone: data.timezone ?? undefined,
        }),
        ...(data.capacity !== undefined && { capacity: data.capacity }),
      },
    });

    if (result.count !== 1) {
      throw new ApiError('Event session was changed or removed', 'CONFLICT');
    }

    return this.prisma.eventSession.findUniqueOrThrow({
      where: { id: data.id },
    });
  }

  async updateStatus(
    id: string,
    ownerId: string,
    fromStatus: EventSessionStatus,
    toStatus: EventSessionStatus,
    cancellationReason?: string | null,
  ) {
    await this.assertOwned(id, ownerId);

    const data: {
      status: EventSessionStatus;
      cancelledAt?: Date;
      cancellationReason?: string | null;
    } = {
      status: toStatus,
    };

    if (toStatus === EventSessionStatus.CANCELLED) {
      data.cancelledAt = new Date();
      data.cancellationReason = cancellationReason;
    }

    const result = await this.prisma.eventSession.updateMany({
      where: {
        id,
        status: fromStatus,
      },
      data,
    });

    if (result.count !== 1) {
      throw new ApiError(
        'Event session state changed or session not found',
        'CONFLICT',
      );
    }

    return this.prisma.eventSession.findUniqueOrThrow({
      where: { id },
    });
  }

  private async assertOwned(id: string, ownerId: string) {
    const session = await this.findByIdAndOwner(id, ownerId);

    if (!session) {
      throw new ApiError('Event session not found', 'NOT_FOUND');
    }
  }
}
