import { describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { EventService } from './event.service';
import { EventsRepository } from '../infrastructure/events.repository';
import { EventsSessionRepository } from '../infrastructure/event-session.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { CreateEventInput } from '../presentation/graphql/inputs/create-event.input';
import { UpdateEventInput } from '../presentation/graphql/inputs/update-event.input';
import { EventStatus } from '@prisma/client';

describe('event poster persistence', () => {
  it('passes create, replacement, draft removal and omitted poster through to Prisma', async () => {
    const event = {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({}),
    };
    const service = new EventService(
      new EventsRepository({ event } as unknown as PrismaService),
      {} as EventsSessionRepository,
      {} as OutboxProcessor,
    );
    const posterImageUrl =
      'https://res.cloudinary.com/demo/image/upload/events/posters/test.png';
    await service.create(
      { title: 'Live', slug: 'live', posterImageUrl },
      'owner',
    );
    expect(event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ posterImageUrl }),
    });
    for (const poster of [posterImageUrl, null]) {
      await service.update({ id: 'event', posterImageUrl: poster }, 'owner');
      expect(event.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'event',
          ownerId: 'owner',
          ...(poster === null && { status: 'DRAFT' }),
        },
        data: expect.objectContaining({ posterImageUrl: poster }),
      });
    }
    await service.update({ id: 'event', title: 'Updated' }, 'owner');
    expect(event.updateMany.mock.lastCall![0].data).not.toHaveProperty(
      'posterImageUrl',
    );
  });

  it('validates poster URLs on both mutation inputs', async () => {
    for (const Input of [CreateEventInput, UpdateEventInput]) {
      const input = Object.assign(new Input(), {
        id: '64b64c0000000000000000e1',
        title: 'Live',
        slug: 'live',
        posterImageUrl: 'https://example.com/poster.png',
      });
      expect(
        (await validate(input)).some((e) => e.property === 'posterImageUrl'),
      ).toBe(true);
      input.posterImageUrl =
        'https://res.cloudinary.com/demo/image/upload/poster.png';
      expect(await validate(input)).toHaveLength(0);
    }
  });

  it('requires a nonblank poster before publishing', async () => {
    const findByIdAndOwner = vi.fn().mockResolvedValue({
      status: EventStatus.DRAFT,
      posterImageUrl: '  ',
      version: 1,
    });
    const updateStatus = vi.fn();
    const service = new EventService(
      { findByIdAndOwner, updateStatus } as unknown as EventsRepository,
      {} as EventsSessionRepository,
      { wake: vi.fn() } as unknown as OutboxProcessor,
    );

    await expect(
      service.updateStatus({ id: 'event', status: EventStatus.PUBLISHED }, 'owner'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
