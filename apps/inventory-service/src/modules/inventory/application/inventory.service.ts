import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  ConfirmInventoryData,
  InventoryRepository,
  ReleaseInventoryData,
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

  release(data: ReleaseInventoryData) {
    if (!data.reservationId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'reservationId is required',
      });
    }

    if (!data.bookingId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'bookingId is required',
      });
    }

    return this.inventoryRepository.release(data);
  }

  confirm(data: ConfirmInventoryData) {
    if (!data.reservationId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'reservationId is required',
      });
    }

    if (!data.bookingId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'bookingId is required',
      });
    }

    return this.inventoryRepository.confirm(data);
  }

  revoke(data: ReleaseInventoryData) {
    if (!data.reservationId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'reservationId is required',
      });
    }

    if (!data.bookingId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'bookingId is required',
      });
    }

    return this.inventoryRepository.revoke(data);
  }

  async createFromTicketTypeCreated(data: {
    ticketTypeId: string;
    sessionId?: string;
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

    // Tra SessionCatalog thay vì tin payload.sessionStatus — catalog được
    // ghi bởi session.status.changed dù event đến trước hay sau created.
    const sessionActive = data.sessionId
      ? (await this.inventoryRepository.sessionStatusOf(data.sessionId)) ===
        'SCHEDULED'
      : false;

    return this.inventoryRepository.create({
      ticketTypeId,
      sessionId: data.sessionId,
      sessionActive,
      name: data.name,
      code: data.code,
      price: data.price,
      currency: data.currency,
      total,
    });
  }

  async applyTicketTypeUpdated(data: {
    ticketTypeId: string;
    name?: string;
    code?: string;
    price?: number;
    currency?: string;
    quantity?: number;
    status?: string;
  }) {
    if (!data.ticketTypeId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'ticketTypeId is required',
      });
    }

    return this.inventoryRepository.applyTicketTypeUpdate(data.ticketTypeId, {
      name: data.name,
      code: data.code,
      price: data.price,
      currency: data.currency,
      quantity: data.quantity,
      typeActive:
        data.status === undefined ? undefined : data.status === 'ACTIVE',
    });
  }

  // ticket-type.deleted — tombstone thay vì xóa hẳn (race-safe).
  applyTicketTypeDeleted(ticketTypeId: string) {
    if (!ticketTypeId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'ticketTypeId is required',
      });
    }
    return this.inventoryRepository.tombstoneByTicketTypeId(ticketTypeId);
  }

  /* session.status.changed — ghi catalog trước rồi flip flag trên các row
     thuộc session. Thứ tự này đảm bảo ticket-type.created đến sau vẫn đọc
     được trạng thái đúng từ catalog. */
  async applySessionStatusChanged(data: { sessionId: string; status: string }) {
    if (!data.sessionId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'sessionId is required',
      });
    }

    await this.inventoryRepository.upsertSessionCatalog(
      data.sessionId,
      data.status,
    );
    return this.inventoryRepository.setSessionActive(
      data.sessionId,
      data.status === 'SCHEDULED',
    );
  }
}
