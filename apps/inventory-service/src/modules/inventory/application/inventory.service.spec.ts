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
