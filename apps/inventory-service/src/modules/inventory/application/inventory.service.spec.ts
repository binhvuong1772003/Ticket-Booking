import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { InventoryService } from './inventory.service';
import { InventoryRepository } from '../infrastructure/inventory.repository';

describe('InventoryService.release', () => {
  let service: InventoryService;
  const release = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: InventoryRepository, useValue: { release } },
      ],
    }).compile();

    service = module.get(InventoryService);
  });

  it('throws INVALID_ARGUMENT when reservationId is empty', () => {
    expect(() =>
      service.release({ reservationId: '', bookingId: 'bk1' }),
    ).toThrow(RpcException);
    expect(release).not.toHaveBeenCalled();
  });

  it('delegates to the repository with the given ids', async () => {
    release.mockResolvedValue({ released: true });

    const result = await service.release({
      reservationId: 'res-1',
      bookingId: 'bk1',
    });

    expect(release).toHaveBeenCalledWith({
      reservationId: 'res-1',
      bookingId: 'bk1',
    });
    expect(result).toEqual({ released: true });
  });
});

describe('InventoryService.getAvailability', () => {
  it('requires a bounded, non-empty list and delegates once', async () => {
    const getAvailability = vi.fn().mockResolvedValue([]);
    const service = new InventoryService({
      getAvailability,
    } as unknown as InventoryRepository);

    expect(() => service.getAvailability([])).toThrow(RpcException);
    expect(() => service.getAvailability([
      { ticketTypeId: 'ticket', sessionId: 'session' },
      ...Array(200).fill({ ticketTypeId: 'id', sessionId: 'session' }),
    ])).toThrow(RpcException);
    expect(() => service.getAvailability([{ ticketTypeId: 'ticket', sessionId: '' }])).toThrow(RpcException);
    await service.getAvailability([
      { ticketTypeId: 'ticket-1', sessionId: 'session-1' },
      { ticketTypeId: 'ticket-2', sessionId: 'session-2' },
    ]);

    expect(getAvailability).toHaveBeenCalledTimes(1);
    expect(getAvailability).toHaveBeenCalledWith([
      { ticketTypeId: 'ticket-1', sessionId: 'session-1' },
      { ticketTypeId: 'ticket-2', sessionId: 'session-2' },
    ]);
  });
});
