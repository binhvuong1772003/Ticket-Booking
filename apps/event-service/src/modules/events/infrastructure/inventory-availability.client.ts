import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable, timeout } from 'rxjs';

type InventoryAvailabilityResponse = {
  items: {
    ticket_type_id: string;
    session_id: string;
    available_quantity: number;
  }[];
};

interface InventoryGrpcService {
  getAvailability(input: {
    ticket_types: { ticket_type_id: string; session_id: string }[];
  }): Observable<InventoryAvailabilityResponse>;
}

export type TicketTypeAvailabilityRequest = {
  ticketTypeId: string;
  sessionId: string;
};

@Injectable()
export class InventoryAvailabilityClient implements OnModuleInit {
  private inventory!: InventoryGrpcService;

  constructor(
    @Inject('INVENTORY_GRPC') private readonly client: ClientGrpc,
  ) {}

  onModuleInit() {
    this.inventory = this.client.getService<InventoryGrpcService>(
      'InventoryService',
    );
  }

  async getAvailability(ticketTypes: TicketTypeAvailabilityRequest[]) {
    const result = new Map<string, number>();
    for (let offset = 0; offset < ticketTypes.length; offset += 200) {
      const response = await firstValueFrom(
        this.inventory
          .getAvailability({
            ticket_types: ticketTypes.slice(offset, offset + 200).map((item) => ({
              ticket_type_id: item.ticketTypeId,
              session_id: item.sessionId,
            })),
          })
          .pipe(timeout(3000)),
      );
      for (const item of response.items ?? []) {
        if (
          typeof item.ticket_type_id !== 'string' ||
          typeof item.session_id !== 'string' ||
          !Number.isSafeInteger(item.available_quantity) ||
          item.available_quantity < 0
        ) {
          throw new Error('inventory-service returned invalid availability');
        }
        result.set(
          `${item.ticket_type_id}:${item.session_id}`,
          item.available_quantity,
        );
      }
    }
    return [...result].map(([key, availableQuantity]) => ({
      key,
      availableQuantity,
    }));
  }
}
