import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  InventoryRepository,
  ReserveInventoryData,
} from '../infrastructure/inventory.repository';

@Injectable()
export class InventoryService {
  constructor(private readonly inventoryRepository: InventoryRepository) {}
  reserve(data: ReserveInventoryData) {
    if (!data.ticketTypeId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'ticketTypeId is required',
      });
    }

    if (!data.bookingId?.trim() || !data.userId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'bookingId and userId are required',
      });
    }

    if (!Number.isInteger(data.quantity) || data.quantity < 1) {
      throw new RpcException({
        code: 3,
        message: 'quantity must be greater than zero',
      });
    }

    return this.inventoryRepository.reserve(data);
  }

  async createFromTicketTypeCreated(data: {
    ticketTypeId: string;
    name: string;
    code: string;
    price: number;
    currency: string;
    total: number;
  }) {
    const { ticketTypeId, total } = data;
    if (!ticketTypeId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'ticketTypeId is required',
      });
    }

    if (!Number.isInteger(total) || total < 1) {
      throw new Error('total must be greater than zero');
    }

    const existing =
      await this.inventoryRepository.findByTicketTypeId(ticketTypeId);

    if (existing) {
      return existing;
    }

    return this.inventoryRepository.create({
      ticketTypeId,
      name: data.name,
      code: data.code,
      price: data.price,
      currency: data.currency,
      total,
    });
  }
}
