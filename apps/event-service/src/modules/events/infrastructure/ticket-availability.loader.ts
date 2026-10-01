import { GraphQLError } from 'graphql';
import { InventoryAvailabilityClient } from './inventory-availability.client';

type PendingAvailability = {
  ticketTypeId: string;
  sessionId: string;
  resolve: (availableQuantity: number) => void;
  reject: (error: Error) => void;
};

export type TicketAvailabilityContext = {
  req: {
    ticketAvailabilityLoader?: TicketAvailabilityLoader;
  };
};

export function requestTicketAvailabilityLoader(
  context: TicketAvailabilityContext,
  client: InventoryAvailabilityClient,
) {
  return (context.req.ticketAvailabilityLoader ??=
    new TicketAvailabilityLoader(client));
}

export class TicketAvailabilityLoader {
  private readonly cache = new Map<string, Promise<number>>();
  private pending = new Map<string, PendingAvailability>();
  private scheduled = false;

  constructor(private readonly client: InventoryAvailabilityClient) {}

  load(ticketTypeId: string, sessionId: string) {
    const key = `${ticketTypeId}:${sessionId}`;
    const existing = this.cache.get(key);
    if (existing) return existing;

    const promise = new Promise<number>((resolve, reject) => {
      this.pending.set(key, { ticketTypeId, sessionId, resolve, reject });
    });
    this.cache.set(key, promise);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => void this.flush());
    }
    return promise;
  }

  private async flush() {
    const batch = this.pending;
    this.pending = new Map();
    this.scheduled = false;
    const ticketTypes = [...batch.values()].map(
      ({ ticketTypeId, sessionId }) => ({ ticketTypeId, sessionId }),
    );
    try {
      const values = await this.client.getAvailability(ticketTypes);
      const availability = new Map(
        values.map((item) => [item.key, item.availableQuantity]),
      );
      for (const [key, pending] of batch) {
        const quantity = availability.get(key);
        if (quantity === undefined) {
          pending.reject(
            new GraphQLError('Ticket inventory is not ready; retry shortly', {
              extensions: { code: 'INVENTORY_NOT_READY' },
            }),
          );
        } else {
          pending.resolve(quantity);
        }
      }
    } catch {
      const error = new GraphQLError(
        'Ticket availability is temporarily unavailable; retry shortly',
        { extensions: { code: 'INVENTORY_UNAVAILABLE' } },
      );
      for (const pending of batch.values()) pending.reject(error);
    }
  }
}
