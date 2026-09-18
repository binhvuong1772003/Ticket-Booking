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
    const hold = await this.inventoryService.reserve({
      ticketTypeId: input.ticket_type_id,
      quantity: input.quantity,
      bookingId: input.booking_id,
      userId: input.user_id,
    });

    return {
      success: true,
      reservation_id: hold.id,
      message: 'Inventory reserved',
    };
  }

  @GrpcMethod('InventoryService', 'Release')
  async release(_input: ReleaseRequest) {
    return {
      success: true,
      message: 'Inventory released',
    };
  }
}
