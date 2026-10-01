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

  getAvailability(ticketTypes: { ticketTypeId: string; sessionId: string }[]) {
    if (
      !Array.isArray(ticketTypes) ||
      ticketTypes.length < 1 ||
      ticketTypes.length > 200 ||
      ticketTypes.some(
        (item) =>
          !item ||
          typeof item.ticketTypeId !== 'string' ||
          !item.ticketTypeId.trim() ||
          typeof item.sessionId !== 'string' ||
          !item.sessionId.trim(),
      )
    ) {
      throw new RpcException({
        code: 3,
        message: 'ticketTypes must contain between 1 and 200 ticket/session pairs',
      });
    }
    return this.inventoryRepository.getAvailability(
      [...new Map(ticketTypes.map((item) => [`${item.ticketTypeId}:${item.sessionId}`, item])).values()],
    );
  }

  reserve(data: ReserveInventoryData) {
    if (!data.ticketTypeId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'ticketTypeId is required',
      });
    }

    if (!data.sessionId?.trim() || !data.eventId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'sessionId and eventId are required',
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
    salesStartAt?: Date | null;
    salesScheduleVersion?: number;
    typeActive?: boolean;
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
      salesStartAt: data.salesStartAt ?? null,
      salesScheduleVersion: data.salesScheduleVersion ?? 0,
      typeActive: data.typeActive,
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
    salesStartAt?: Date | null;
    salesScheduleVersion?: number;
    inventorySnapshot?: {
      sessionId: string;
      name: string;
      code: string;
      price: number;
      currency: string;
      quantity: number;
      status: string;
    };
  }) {
    if (!data.ticketTypeId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'ticketTypeId is required',
      });
    }

    if (data.salesStartAt !== undefined && data.inventorySnapshot) {
      const snapshot = data.inventorySnapshot;
      await this.createFromTicketTypeCreated({
        ticketTypeId: data.ticketTypeId,
        sessionId: snapshot.sessionId,
        name: snapshot.name,
        code: snapshot.code,
        price: snapshot.price,
        currency: snapshot.currency,
        total: snapshot.quantity,
        typeActive: snapshot.status === 'ACTIVE',
        salesStartAt: data.salesStartAt,
        salesScheduleVersion: data.salesScheduleVersion,
      });
    }
    return this.inventoryRepository.applyTicketTypeUpdate(data.ticketTypeId, {
      name: data.name,
      code: data.code,
      price: data.price,
      currency: data.currency,
      quantity: data.quantity,
      salesStartAt: data.salesStartAt,
      salesScheduleVersion: data.salesScheduleVersion,
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
  async applySessionStatusChanged(data: {
    sessionId: string;
    eventId?: string;
    status: string;
  }) {
    if (!data.sessionId?.trim()) {
      throw new RpcException({
        code: 3,
        message: 'sessionId is required',
      });
    }

    await this.inventoryRepository.upsertSessionCatalog(
      data.sessionId,
      data.status,
      data.eventId,
    );
    return this.inventoryRepository.setSessionActive(
      data.sessionId,
      data.status === 'SCHEDULED',
    );
  }
}
