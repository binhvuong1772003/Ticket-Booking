import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { InventoryService } from '../../application/inventory.service';

type ReserveRequest = {
  session_id: string;
  ticket_type_id: string;
  quantity: number;
  booking_id: string;
  user_id: string;
};

type ReleaseRequest = {
  reservation_id: string;
  booking_id: string;
};

@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @GrpcMethod('InventoryService', 'Reserve')
  async reserve(input: ReserveRequest) {
    const { hold, inventory } = await this.inventoryService.reserve({
      ticketTypeId: input.ticket_type_id,
      quantity: input.quantity,
      bookingId: input.booking_id,
      userId: input.user_id,
    });

    return {
      success: true,
      reservation_id: hold.id,
      message: 'Inventory reserved',
      ticket_type_name: inventory.name ?? '',
      ticket_type_code: inventory.code ?? '',
      unit_price: inventory.price ?? 0,
      currency: inventory.currency ?? '',
    };
  }

  @GrpcMethod('InventoryService', 'Release')
  async release(input: ReleaseRequest) {
    const result = await this.inventoryService.release({
      reservationId: input.reservation_id,
      bookingId: input.booking_id,
    });
    return {
      success: true,
      message: result.released
        ? 'Inventory released'
        : 'Hold not active; nothing to release',
    };
  }
}
