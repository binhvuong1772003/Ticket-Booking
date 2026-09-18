import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, Observable } from 'rxjs';
import { randomBytes } from 'node:crypto';
import { CreateBookingInput } from '../presentation/graphql/inputs/create-booking.input';
import { BookingRepository } from '../infrastructure/booking.repository';

interface ReserveRequest {
  session_id: string;
  ticket_type_id: string;
  quantity: number;
  booking_id: string;
  user_id: string;
}

export interface ReserveResponse {
  success: boolean;
  reservation_id: string;
  message: string;
}

interface ReleaseRequest {
  reservation_id: string;
  booking_id: string;
}

interface ReleaseResponse {
  success: boolean;
  message: string;
}

interface InventoryGrpcService {
  reserve(input: ReserveRequest): Observable<ReserveResponse>;
  release(input: ReleaseRequest): Observable<ReleaseResponse>;
}

export type CreateBookingMessage = {
  booking_id: string;
  user_id: string;
  session_id: string;
  ticket_type_id: string;
  quantity: number;
};

@Injectable()
export class BookingService implements OnModuleInit {
  private inventoryService!: InventoryGrpcService;

  constructor(
    @Inject('INVENTORY_GRPC')
    private readonly inventoryClient: ClientGrpc,
    private readonly bookingRepository: BookingRepository,
  ) {}

  onModuleInit() {
    this.inventoryService =
      this.inventoryClient.getService<InventoryGrpcService>('InventoryService');
  }

  getHealth() {
    return { service: 'booking-service', status: 'ok' };
  }

  async create(input: CreateBookingInput, userId: string) {
    if (!userId?.trim()) {
      throw new BadRequestException('Authenticated user is required');
    }

    const bookingId = randomBytes(12).toString('hex');
    const booking = await this.bookingRepository.createPending({
      id: bookingId,
      userId,
      eventId: input.eventId,
      sessionId: input.sessionId,
      ticketTypeId: input.ticketTypeId,
      ticketTypeName: input.ticketTypeName,
      ticketTypeCode: input.ticketTypeCode,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      currency: input.currency ?? 'USD',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    let reservationId: string | undefined;

    try {
      const reservation = await this.reserveInventory({
        booking_id: booking.id,
        user_id: userId,
        session_id: input.sessionId,
        ticket_type_id: input.ticketTypeId,
        quantity: input.quantity,
      });

      reservationId = reservation.reservation_id;

      return this.bookingRepository.attachReservation(
        booking.id,
        input.ticketTypeId,
        reservationId,
      );
    } catch (error) {
      if (reservationId) {
        await this.releaseInventory(reservationId, booking.id).catch(() => {
          // Inventory release can be retried by a later compensation flow.
        });
      }

      await this.bookingRepository.cancel(booking.id);
      throw error;
    }
  }

  reserveInventory(input: CreateBookingMessage) {
    return firstValueFrom(
      this.inventoryService.reserve({
        session_id: input.session_id,
        ticket_type_id: input.ticket_type_id,
        quantity: input.quantity,
        booking_id: input.booking_id,
        user_id: input.user_id,
      }),
    );
  }

  private releaseInventory(reservationId: string, bookingId: string) {
    return firstValueFrom(
      this.inventoryService.release({
        reservation_id: reservationId,
        booking_id: bookingId,
      }),
    );
  }
}
