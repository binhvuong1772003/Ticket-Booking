import { describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { CreateTicketTypeInput } from '../presentation/graphql/inputs/create-ticket-type.input';
import { TicketTypeRepository } from './ticket-type.repository';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

describe('ticket sales schedule persistence', () => {
  it.each([
    new Date('2026-10-01T00:00:00.000Z'),
    new Date('2020-01-01T00:00:00Z'),
    null,
    undefined,
  ])(
    'stores and serializes %s in the same transaction',
    async (salesStartAt) => {
      const create = vi.fn(async ({ data }) => ({ id: 'tt1', ...data }));
      const outbox = vi.fn();
      const prisma = {
        $transaction: vi.fn(async (fn) =>
          fn({ ticketType: { create }, outboxEvent: { create: outbox } }),
        ),
      };
      const repo = new TicketTypeRepository(prisma as unknown as PrismaService);
      const result = await repo.createWithOutbox({
        sessionId: 's1',
        sessionStatus: 'DRAFT',
        name: 'VIP',
        code: 'VIP',
        price: 100,
        currency: 'USD',
        quantity: 10,
        salesStartAt,
      });
      expect(result.salesStartAt).toEqual(salesStartAt ?? null);
      expect(outbox).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            payload: expect.objectContaining({
              salesStartAt: salesStartAt?.toISOString() ?? null,
            }),
          }),
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects invalid dates at the GraphQL input boundary', async () => {
    const input = Object.assign(new CreateTicketTypeInput(), {
      sessionId: '000000000000000000000001',
      name: 'VIP',
      code: 'VIP',
      price: 100,
      quantity: 1,
      salesStartAt: new Date('invalid'),
    });
    expect(
      (await validate(input)).some(
        (error) => error.property === 'salesStartAt',
      ),
    ).toBe(true);
  });
});

describe('schedule updates in the outbox', () => {
  it.each([new Date('2026-10-02T00:00:00Z'), null])(
    'increments the schedule version and publishes a bootstrap snapshot for %s',
    async (salesStartAt) => {
      const current = {
        id: 'tt1',
        sessionId: 's1',
        name: 'VIP',
        code: 'VIP',
        price: 100,
        currency: 'USD',
        quantity: 10,
        status: 'ACTIVE',
        salesScheduleVersion: 2,
      };
      const update = vi.fn(async ({ data }) => ({ ...current, ...data }));
      const outbox = vi.fn();
      const repo = new TicketTypeRepository({
        $transaction: async (fn) =>
          fn({
            ticketType: { findUniqueOrThrow: async () => current, update },
            outboxEvent: { create: outbox },
          }),
      } as unknown as PrismaService);
      const result = await repo.updateWithOutbox('tt1', { salesStartAt });
      expect(result.salesScheduleVersion).toBe(3);
      expect(outbox).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            payload: expect.objectContaining({
              salesStartAt: salesStartAt?.toISOString() ?? null,
              salesScheduleVersion: 3,
              inventorySnapshot: {
                sessionId: 's1',
                name: 'VIP',
                code: 'VIP',
                price: 100,
                currency: 'USD',
                quantity: 10,
                status: 'ACTIVE',
              },
            }),
          }),
        }),
      );
    },
  );
});
