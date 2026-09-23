import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ApiError } from '../../../common/errors/api-error';
import { Prisma, EventStatus } from '@prisma/client';

export type CreateEventData = {
  ownerId: string;
  title: string;
  slug: string;
  summary?: string;
  organizerDisplayName?: string;
  contactEmail?: string;
  contactPhone?: string;
  coverImageUrl?: string;
};
export type UpdateEventData = {
  ownerId: string;
  id: string;
  title?: string;
  slug?: string;
  summary?: string | null;
  organizerDisplayName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  coverImageUrl?: string | null;
};

@Injectable()
export class EventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findPublished() {
    return this.prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
    });
  }

  findByOwner(ownerId: string) {
    return this.prisma.event.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  findById(id: string) {
    return this.prisma.event.findUnique({
      where: { id },
      include: {
        sessions: {
          orderBy: { startsAt: 'asc' },
          include: { ticketTypes: true },
        },
      },
    });
  }

  async create(data: CreateEventData) {
    try {
      return await this.prisma.event.create({
        data: {
          ownerId: data.ownerId,
          title: data.title,
          slug: data.slug,
          summary: data.summary,
          organizerDisplayName: data.organizerDisplayName,
          contactEmail: data.contactEmail,
          contactPhone: data.contactPhone,
          coverImageUrl: data.coverImageUrl,
          status: 'DRAFT',
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ApiError('Slug already exists', 'CONFLICT', {
          field: 'slug',
        });
      }

      throw error;
    }
  }
  async update(data: UpdateEventData) {
    try {
      const result = await this.prisma.event.updateMany({
        where: {
          id: data.id,
          ownerId: data.ownerId,
        },
        data: {
          ...(data.title !== undefined && { title: data.title }),
          ...(data.slug !== undefined && { slug: data.slug }),
          ...(data.summary !== undefined && { summary: data.summary }),
          ...(data.organizerDisplayName !== undefined && {
            organizerDisplayName: data.organizerDisplayName,
          }),
          ...(data.contactEmail !== undefined && {
            contactEmail: data.contactEmail,
          }),
          ...(data.contactPhone !== undefined && {
            contactPhone: data.contactPhone,
          }),
          ...(data.coverImageUrl !== undefined && {
            coverImageUrl: data.coverImageUrl,
          }),
          version: {
            increment: 1,
          },
        },
      });

      if (result.count !== 1) {
        throw new ApiError('Event not found', 'NOT_FOUND');
      }

      return this.prisma.event.findUniqueOrThrow({
        where: { id: data.id },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ApiError('Slug already exists', 'CONFLICT', {
          field: 'slug',
        });
      }

      throw error;
    }
  }
  async updateStatus(
    id: string,
    ownerId: string,
    fromStatus: EventStatus,
    toStatus: EventStatus,
    cancellationReason?: string | null,
  ) {
    const now = new Date();
    const data: Prisma.EventUpdateManyMutationInput = {
      status: toStatus,
      version: {
        increment: 1,
      },
    };
    switch (toStatus) {
      case EventStatus.PUBLISHED:
        data.publishedAt = now;
        break;
      case EventStatus.ARCHIVED:
        data.archivedAt = now;
        break;
      case EventStatus.CANCELLED:
        data.cancelledAt = now;
        if (cancellationReason) {
          data.cancellationReason = cancellationReason;
        }
        break;
    }
    const result = await this.prisma.event.updateMany({
      where: {
        id,
        ownerId,
        status: fromStatus,
      },
      data,
    });

    if (result.count !== 1) {
      throw new ApiError('Event state changed or event not found', 'CONFLICT');
    }

    return this.prisma.event.findUniqueOrThrow({
      where: { id },
    });
  }
  findByIdAndOwner(id: string, ownerId: string) {
    return this.prisma.event.findFirst({
      where: {
        id,
        ownerId,
      },
    });
  }
}
