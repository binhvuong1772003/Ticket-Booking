import { describe, expect, it, vi } from 'vitest';
import {
  TicketTypeCreatedHandler,
  TicketTypeCreatedEvent,
} from './ticket-type-created.handler';
import { InventoryService } from '../inventory.service';
import { InventoryRepository } from '../../infrastructure/inventory.repository';

function setup() {
  const repository = {
    findByTicketTypeId: vi.fn().mockResolvedValue(null),
    sessionStatusOf: vi.fn().mockResolvedValue('SCHEDULED'),
    create: vi.fn(async (data) => data),
  };
  const service = new InventoryService(
    repository as unknown as InventoryRepository,
  );
  return { handler: new TicketTypeCreatedHandler(service), repository };
}
function event(salesStartAt: unknown): TicketTypeCreatedEvent {
  return {
    eventId: 'e1',
    eventType: 'ticket-type.created',
    occurredAt: '2026-09-01T00:00:00Z',
    payload: {
      ticketTypeId: 'tt1',
      sessionId: 's1',
      name: 'VIP',
      code: 'VIP',
      price: 100,
      currency: 'USD',
      quantity: 10,
      salesStartAt,
    },
  } as TicketTypeCreatedEvent;
}

describe('ticket sales schedule consumer', () => {
  it.each(['2026-10-01T07:00:00+07:00', '2026-10-01T00:00:00.000Z'])(
    'preserves the instant from %s through the service',
    async (value) => {
      const { handler } = setup();
      expect(await handler.handle(event(value))).toMatchObject({
        salesStartAt: new Date('2026-10-01T00:00:00.000Z'),
      });
    },
  );
  it.each([null, undefined])('accepts legacy/unscheduled %s', async (value) => {
    const { handler } = setup();
    expect(await handler.handle(event(value))).toMatchObject({
      salesStartAt: null,
    });
  });
  it.each([
    'bad-date',
    '',
    123,
    {},
    '2026-10-01',
    '2026-10-01T07:00:00',
    '2026-02-30T07:00:00Z',
  ])(
    'rejects malformed schedule %j without creating inventory',
    async (value) => {
      const { handler, repository } = setup();
      await expect(
        Promise.resolve().then(() => handler.handle(event(value))),
      ).rejects.toThrow();
      expect(repository.create).not.toHaveBeenCalled();
    },
  );
  it('does not replace an existing inventory on duplicate creation', async () => {
    const { handler, repository } = setup();
    const existing = {
      id: 'inv1',
      salesStartAt: new Date('2026-10-01T00:00:00Z'),
      available: 3,
    };
    repository.findByTicketTypeId.mockResolvedValue(existing);
    expect(await handler.handle(event(undefined))).toBe(existing);
    expect(repository.create).not.toHaveBeenCalled();
  });
});
