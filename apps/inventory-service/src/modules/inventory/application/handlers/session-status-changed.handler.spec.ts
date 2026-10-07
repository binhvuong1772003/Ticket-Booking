import { describe, expect, it, vi } from 'vitest';
import { InventoryService } from '../inventory.service';
import { SessionStatusChangedHandler } from './session-status-changed.handler';

describe('SessionStatusChangedHandler', () => {
  it('uses the payload event ID, never the envelope message ID', async () => {
    const applySessionStatusChanged = vi.fn();
    const handler = new SessionStatusChangedHandler({
      applySessionStatusChanged,
    } as unknown as InventoryService);

    await handler.handle({
      eventId: 'message-id',
      eventType: 'session.status.changed',
      occurredAt: new Date().toISOString(),
      payload: {
        sessionId: 'sess1',
        eventId: 'domain-event-id',
        status: 'SCHEDULED',
      },
    });

    expect(applySessionStatusChanged).toHaveBeenCalledWith({
      sessionId: 'sess1',
      eventId: 'domain-event-id',
      status: 'SCHEDULED',
    });
  });

  it('accepts legacy payloads without a domain event ID', async () => {
    const applySessionStatusChanged = vi.fn();
    const handler = new SessionStatusChangedHandler({
      applySessionStatusChanged,
    } as unknown as InventoryService);

    await handler.handle({
      eventId: 'message-id',
      eventType: 'session.status.changed',
      occurredAt: new Date().toISOString(),
      payload: { sessionId: 'sess1', status: 'CANCELLED' },
    });

    expect(applySessionStatusChanged).toHaveBeenCalledWith({
      sessionId: 'sess1',
      eventId: undefined,
      status: 'CANCELLED',
    });
  });
});
