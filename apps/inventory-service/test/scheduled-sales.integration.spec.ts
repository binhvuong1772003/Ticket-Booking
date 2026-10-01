import { PrismaService as EventPrismaService } from '../../event-service/src/infrastructure/prisma/prisma.service';
import { TicketTypeRepository } from '../../event-service/src/modules/events/infrastructure/ticket-type.repository';
import { TicketTypeUpdatedHandler } from '../src/modules/inventory/application/handlers/ticket-type-updated.handler';
import { InventoryService } from '../src/modules/inventory/application/inventory.service';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { InventoryRepository } from '../src/modules/inventory/infrastructure/inventory.repository';

// Opt in with a dedicated MongoDB replica set. Never fall back to DATABASE_URL.
const url = process.env.SCHEDULED_SALES_TEST_DATABASE_URL;
describe.skipIf(!url)('scheduled sales (real MongoDB)', () => {
  const prisma = new PrismaService({ datasourceUrl: url });
  const repo = new InventoryRepository(prisma);
  const ids: string[] = [];
  const sessionIds: string[] = [];
  const opens = new Date('2026-10-01T00:00:00.000Z');
  beforeAll(() => prisma.$connect());
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await prisma.inventoryHold.deleteMany({
      where: { inventoryId: { in: ids } },
    });
    await prisma.inventory.deleteMany({ where: { id: { in: ids } } });
    await prisma.sessionCatalog.deleteMany({
      where: { sessionId: { in: sessionIds } },
    });
    await prisma.$disconnect();
  });
  async function inventory(salesStartAt: Date | null, total = 2) {
    const sessionId = randomUUID();
    const eventId = randomUUID();
    const row = await repo.create({
      ticketTypeId: randomUUID(),
      sessionId,
      total,
      sessionActive: true,
      salesStartAt,
    });
    ids.push(row!.id);
    sessionIds.push(sessionId);
    await repo.upsertSessionCatalog(sessionId, 'SCHEDULED', eventId);
    return { ...row!, sessionId, eventId };
  }
  function reserve(
    row: { ticketTypeId: string; sessionId: string; eventId: string },
    overrides: Partial<{ sessionId: string; eventId: string }> = {},
  ) {
    return repo.reserve({
      ticketTypeId: row.ticketTypeId,
      sessionId: overrides.sessionId ?? row.sessionId,
      eventId: overrides.eventId ?? row.eventId,
      quantity: 1,
      bookingId: randomUUID(),
      userId: 'schedule-test-user',
    });
  }

  it('rejects session and event mismatches without changing stock or holds', async () => {
    const row = await inventory(new Date('2000-01-01T00:00:00Z'));

    await expect(
      reserve(row, { sessionId: randomUUID() }),
    ).rejects.toMatchObject({ error: { code: 3 } });
    await expect(
      reserve(row, { eventId: randomUUID() }),
    ).rejects.toMatchObject({ error: { code: 3 } });

    await expect(
      prisma.inventory.findUniqueOrThrow({ where: { id: row.id } }),
    ).resolves.toMatchObject({ available: 2, reserved: 0 });
    expect(
      await prisma.inventoryHold.count({ where: { inventoryId: row.id } }),
    ).toBe(0);
  });

  it('returns the catalog IDs for a valid reservation', async () => {
    const row = await inventory(new Date('2000-01-01T00:00:00Z'));

    await expect(reserve(row)).resolves.toMatchObject({
      ticketTypeId: row.ticketTypeId,
      sessionId: row.sessionId,
      eventId: row.eventId,
      hold: { status: 'ACTIVE' },
      inventory: { price: null, name: null },
    });
  });

  it('returns unavailable without stock changes when a server mapping is absent', async () => {
    const missingInventorySession = await repo.create({
      ticketTypeId: randomUUID(),
      total: 1,
      sessionActive: true,
      salesStartAt: new Date('2000-01-01T00:00:00Z'),
    });
    ids.push(missingInventorySession!.id);
    const unmappedSessionId = randomUUID();
    const missingCatalog = await repo.create({
      ticketTypeId: randomUUID(),
      sessionId: unmappedSessionId,
      total: 1,
      sessionActive: true,
      salesStartAt: new Date('2000-01-01T00:00:00Z'),
    });
    ids.push(missingCatalog!.id);

    await expect(
      repo.reserve({
        ticketTypeId: missingInventorySession!.ticketTypeId,
        sessionId: randomUUID(),
        eventId: randomUUID(),
        quantity: 1,
        bookingId: randomUUID(),
        userId: 'mapping-test-user',
      }),
    ).rejects.toMatchObject({ error: { code: 14 } });
    await expect(
      repo.reserve({
        ticketTypeId: missingCatalog!.ticketTypeId,
        sessionId: unmappedSessionId,
        eventId: randomUUID(),
        quantity: 1,
        bookingId: randomUUID(),
        userId: 'mapping-test-user',
      }),
    ).rejects.toMatchObject({ error: { code: 14 } });
    expect(
      await prisma.inventoryHold.count({
        where: {
          inventoryId: {
            in: [missingInventorySession!.id, missingCatalog!.id],
          },
        },
      }),
    ).toBe(0);
  });

  it('keeps one event binding under concurrent status messages and still applies later status', async () => {
    const sessionId = randomUUID();
    const eventIds = [randomUUID(), randomUUID()] as const;
    sessionIds.push(sessionId);
    const service = new InventoryService(repo);

    await Promise.all(
      eventIds.map((eventId, index) =>
        service.applySessionStatusChanged({
          sessionId,
          eventId,
          status: index === 0 ? 'SCHEDULED' : 'CANCELLED',
        }),
      ),
    );
    const binding = await prisma.sessionCatalog.findUniqueOrThrow({
      where: { sessionId },
    });
    expect(eventIds).toContain(binding.eventId);

    await service.applySessionStatusChanged({
      sessionId,
      eventId: randomUUID(),
      status: 'CANCELLED',
    });
    await expect(
      prisma.sessionCatalog.findUniqueOrThrow({ where: { sessionId } }),
    ).resolves.toMatchObject({ eventId: binding.eventId, status: 'CANCELLED' });
  });

  it.each([
    ['2026-09-30T23:59:59.999Z', false],
    ['2026-10-01T00:00:00.000Z', true],
    ['2026-10-01T00:00:00.001Z', true],
  ] as const)('enforces the actual query at %s', async (now, allowed) => {
    const row = await inventory(opens);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    if (allowed) {
      await expect(reserve(row)).resolves.toMatchObject({
        hold: { status: 'ACTIVE' },
      });
    } else {
      await expect(reserve(row)).rejects.toMatchObject({
        error: { code: 9, message: 'Ticket sales have not started' },
      });
    }
    const current = await prisma.inventory.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(current.available).toBe(allowed ? 1 : 2);
    expect(current.reserved).toBe(allowed ? 1 : 0);
    expect(
      await prisma.inventoryHold.count({ where: { inventoryId: row.id } }),
    ).toBe(allowed ? 1 : 0);
  });

  it('allows only one concurrent buyer to reserve the last ticket', async () => {
    const row = await inventory(new Date('2000-01-01T00:00:00.000Z'), 1);
    const results = await Promise.allSettled([reserve(row), reserve(row)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(
      prisma.inventory.findUniqueOrThrow({ where: { id: row.id } }),
    ).resolves.toMatchObject({ available: 0, reserved: 1 });
    await expect(
      prisma.inventoryHold.count({ where: { inventoryId: row.id } }),
    ).resolves.toBe(1);
  });

  it.each([false, true])(
    'allows legacy sales with missing field = %s',
    async (missing) => {
      const row = await inventory(null);
      if (missing) {
        await prisma.$runCommandRaw({
          update: 'inventories',
          updates: [
            {
              q: { _id: { $oid: row.id } },
              u: { $unset: { salesStartAt: '' } },
            },
          ],
        });
      }
      await expect(reserve(row)).resolves.toMatchObject({
        hold: { status: 'ACTIVE' },
      });
    },
  );

  it.each(['sessionActive', 'typeActive'])(
    'does not bypass %s after opening',
    async (field) => {
      const row = await inventory(new Date('2000-01-01T00:00:00Z'));
      await prisma.inventory.update({
        where: { id: row.id },
        data: { [field]: false },
      });
      await expect(reserve(row)).rejects.toMatchObject({
        error: { code: 9, message: 'Ticket type is not on sale' },
      });
      expect(
        await prisma.inventoryHold.count({ where: { inventoryId: row.id } }),
      ).toBe(0);
    },
  );

  it('sells the last ticket at most once under concurrent requests', async () => {
    const row = await inventory(new Date('2000-01-01T00:00:00Z'), 1);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => reserve(row)),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await prisma.inventory.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ available: 0, reserved: 1 });
    expect(
      await prisma.inventoryHold.count({ where: { inventoryId: row.id } }),
    ).toBe(1);
  });
  it('applies only newer schedule revisions, including a null reset', async () => {
    const row = await inventory(opens);
    const later = new Date('2027-01-01T00:00:00Z');
    await repo.applyTicketTypeUpdate(row.ticketTypeId, {
      salesStartAt: later,
      salesScheduleVersion: 2,
    });
    await repo.applyTicketTypeUpdate(row.ticketTypeId, {
      salesStartAt: null,
      salesScheduleVersion: 1,
    });
    expect(
      await prisma.inventory.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      salesStartAt: later,
      salesScheduleVersion: 2,
      available: 2,
    });
    await repo.applyTicketTypeUpdate(row.ticketTypeId, {
      salesStartAt: null,
      salesScheduleVersion: 3,
    });
    await repo.applyTicketTypeUpdate(row.ticketTypeId, {
      salesStartAt: later,
      salesScheduleVersion: 2,
    });
    expect(
      await prisma.inventory.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      salesStartAt: null,
      salesScheduleVersion: 3,
      available: 2,
    });
    await expect(reserve(row)).resolves.toMatchObject({
      hold: { status: 'ACTIVE' },
    });
  });

  it('retains the latest schedule when update arrives before create', async () => {
    const ticketTypeId = randomUUID();
    const service = new InventoryService(repo);
    const handler = new TicketTypeUpdatedHandler(service);
    const later = '2027-01-01T00:00:00Z';
    await handler.handle({
      eventId: randomUUID(),
      eventType: 'ticket-type.updated',
      occurredAt: new Date().toISOString(),
      payload: {
        ticketTypeId,
        salesStartAt: later,
        salesScheduleVersion: 2,
        inventorySnapshot: {
          sessionId: 'test-session',
          name: 'VIP',
          code: 'VIP',
          price: 100,
          currency: 'USD',
          quantity: 10,
          status: 'ACTIVE',
        },
      },
    });
    const updated = await prisma.inventory.findUniqueOrThrow({
      where: { ticketTypeId },
    });
    ids.push(updated.id);
    await service.createFromTicketTypeCreated({
      ticketTypeId,
      sessionId: 'test-session',
      name: 'VIP',
      code: 'VIP',
      price: 100,
      currency: 'USD',
      total: 10,
      salesStartAt: opens,
    });
    expect(
      await prisma.inventory.findUniqueOrThrow({ where: { ticketTypeId } }),
    ).toMatchObject({
      salesStartAt: new Date(later),
      salesScheduleVersion: 2,
      available: 10,
    });
  });

  it('updates a legacy inventory without a schedule revision', async () => {
    const row = await inventory(opens);
    await prisma.$runCommandRaw({
      update: 'inventories',
      updates: [
        {
          q: { _id: { $oid: row.id } },
          u: { $unset: { salesScheduleVersion: '' } },
        },
      ],
    });
    await repo.applyTicketTypeUpdate(row.ticketTypeId, {
      salesStartAt: null,
      salesScheduleVersion: 1,
    });
    expect(
      await prisma.inventory.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ salesStartAt: null, salesScheduleVersion: 1 });
  });

  it('does not reactivate a deleted inventory when a schedule update arrives late', async () => {
    const ticketTypeId = randomUUID();
    const tombstone = await repo.tombstoneByTicketTypeId(ticketTypeId);
    ids.push(tombstone.id);
    await new TicketTypeUpdatedHandler(new InventoryService(repo)).handle({
      eventId: randomUUID(),
      eventType: 'ticket-type.updated',
      occurredAt: new Date().toISOString(),
      payload: {
        ticketTypeId,
        salesStartAt: null,
        salesScheduleVersion: 1,
        inventorySnapshot: {
          sessionId: 'test-session',
          name: 'VIP',
          code: 'VIP',
          price: 100,
          currency: 'USD',
          quantity: 10,
          status: 'ACTIVE',
        },
      },
    });
    expect(
      await prisma.inventory.findUniqueOrThrow({ where: { ticketTypeId } }),
    ).toMatchObject({ available: 0, typeActive: false });
  });

  it('keeps the latest concurrent revision after conflict redelivery', async () => {
    const row = await inventory(opens);
    const updates = [
      {
        salesStartAt: new Date('2027-01-01T00:00:00Z'),
        salesScheduleVersion: 1,
      },
      { salesStartAt: null, salesScheduleVersion: 2 },
    ];
    const outcomes = await Promise.allSettled(
      updates.map((update) =>
        repo.applyTicketTypeUpdate(row.ticketTypeId, update),
      ),
    );
    for (let i = 0; i < outcomes.length; i++)
      if (outcomes[i].status === 'rejected')
        await repo.applyTicketTypeUpdate(row.ticketTypeId, updates[i]);
    expect(
      await prisma.inventory.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      salesStartAt: null,
      salesScheduleVersion: 2,
      available: 2,
    });
  });

  it('persists source revisions and JSON snapshots on legacy ticket types', async () => {
    const source = new EventPrismaService({ datasourceUrl: url });
    let ticketId: string | undefined;
    try {
      const ticket = await source.ticketType.create({
        data: {
          sessionId: '000000000000000000000001',
          name: 'VIP',
          code: randomUUID(),
          price: 100,
          quantity: 10,
          salesStartAt: opens,
        },
      });
      ticketId = ticket.id;
      await source.$runCommandRaw({
        update: 'TicketType',
        updates: [
          {
            q: { _id: { $oid: ticket.id } },
            u: { $unset: { salesScheduleVersion: '' } },
          },
        ],
      });
      const repository = new TicketTypeRepository(source);
      await repository.updateWithOutbox(ticket.id, {
        salesStartAt: new Date('2027-01-01T00:00:00Z'),
      });
      await repository.updateWithOutbox(ticket.id, { salesStartAt: null });
      expect(
        await source.ticketType.findUniqueOrThrow({ where: { id: ticket.id } }),
      ).toMatchObject({ salesStartAt: null, salesScheduleVersion: 2 });
      const events = await source.outboxEvent.findMany({
        where: { aggregateId: ticket.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((event) => event.payload)).toEqual([
        expect.objectContaining({
          salesStartAt: '2027-01-01T00:00:00.000Z',
          salesScheduleVersion: 1,
          inventorySnapshot: expect.objectContaining({ quantity: 10 }),
        }),
        expect.objectContaining({
          salesStartAt: null,
          salesScheduleVersion: 2,
        }),
      ]);
    } finally {
      if (ticketId) {
        await source.outboxEvent.deleteMany({
          where: { aggregateId: ticketId },
        });
        await source.ticketType.delete({ where: { id: ticketId } });
      }
      await source.$disconnect();
    }
  });
});
