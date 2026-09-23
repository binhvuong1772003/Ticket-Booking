import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { EventService } from './event.service';
import { EventsRepository } from '../infrastructure/events.repository';

const published = { id: 'e1', ownerId: 'u1', status: 'PUBLISHED' };
const draft = { id: 'e2', ownerId: 'u1', status: 'DRAFT' };

describe('EventService.findById visibility', () => {
  let service: EventService;
  const findById = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: EventsRepository, useValue: { findById } },
      ],
    }).compile();
    service = module.get(EventService);
  });

  it('returns a published event to anonymous viewers', async () => {
    findById.mockResolvedValue(published);
    await expect(
      service.findById('64b64c0000000000000000e1'),
    ).resolves.toBe(published);
  });

  it('hides non-published events from anonymous viewers', async () => {
    findById.mockResolvedValue(draft);
    await expect(
      service.findById('64b64c0000000000000000e2'),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('returns a draft to its owner', async () => {
    findById.mockResolvedValue(draft);
    await expect(
      service.findById('64b64c0000000000000000e2', { sub: 'u1' }),
    ).resolves.toBe(draft);
  });

  it('returns a draft to an admin', async () => {
    findById.mockResolvedValue(draft);
    await expect(
      service.findById('64b64c0000000000000000e2', {
        sub: 'other',
        role: 'ADMIN',
      }),
    ).resolves.toBe(draft);
  });

  it('rejects malformed ids without hitting the repository', async () => {
    await expect(service.findById('not-an-id')).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(findById).not.toHaveBeenCalled();
  });
});
