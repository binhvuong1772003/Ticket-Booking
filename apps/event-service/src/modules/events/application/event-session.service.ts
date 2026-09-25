import { Injectable } from '@nestjs/common';
import { EventSessionStatus, EventStatus } from '@prisma/client';
import { CreateEventSessionInput } from '../presentation/graphql/inputs/create-event-session.input';
import { UpdateEventSessionInput } from '../presentation/graphql/inputs/update-event-session.input';
import { UpdateEventSessionStatusInput } from '../presentation/graphql/inputs/update-event-session-status.input';
import { EventsRepository } from '../infrastructure/events.repository';
import { TicketTypeRepository } from '../infrastructure/ticket-type.repository';
import {
  CreateEventSessionData,
  EventsSessionRepository,
  RescheduleSessionData,
  UpdateEventSessionData,
} from '../infrastructure/event-session.repository';
import { RescheduleSessionInput } from '../presentation/graphql/inputs/reschedule-session.input';
import { ApiError } from '../../../common/errors/api-error';
import { OutboxProcessor } from '../infrastructure/outbox.processor';

@Injectable()
export class EventSessionService {
  constructor(
    private readonly eventsRepository: EventsRepository,
    private readonly eventsSessionRepository: EventsSessionRepository,
    private readonly ticketTypeRepository: TicketTypeRepository,
    private readonly outboxProcessor: OutboxProcessor,
  ) {}

  async create(input: CreateEventSessionInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const event = await this.eventsRepository.findByIdAndOwner(
      input.eventId,
      ownerId,
    );

    if (!event) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    if (
      event.status === EventStatus.CANCELLED ||
      event.status === EventStatus.ARCHIVED
    ) {
      throw new ApiError(
        'Cannot add a session to a closed event',
        'BAD_USER_INPUT',
      );
    }

    const startsAt = input.startsAt ?? null;
    const endsAt = input.endsAt ?? null;

    if ((startsAt === null) !== (endsAt === null)) {
      throw new ApiError(
        'startsAt and endsAt must be provided together',
        'BAD_USER_INPUT',
      );
    }

    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new ApiError(
        'endsAt must be later than startsAt',
        'BAD_USER_INPUT',
      );
    }

    const data: CreateEventSessionData = {
      eventId: input.eventId,
      name: input.name,
      venueName: input.venueName,
      venueAddress: input.venueAddress,
      city: input.city,
      countryCode: input.countryCode,
      startsAt,
      endsAt,
      timezone: input.timezone,
      capacity: input.capacity,
    };

    return this.eventsSessionRepository.create(data);
  }

  async update(input: UpdateEventSessionInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const session = await this.eventsSessionRepository.findByIdAndOwner(
      input.id,
      ownerId,
    );

    if (!session) {
      throw new ApiError('Event session not found', 'NOT_FOUND');
    }

    if (
      session.event.status === EventStatus.CANCELLED ||
      session.event.status === EventStatus.ARCHIVED
    ) {
      throw new ApiError(
        'Cannot modify a session of a closed event',
        'BAD_USER_INPUT',
      );
    }

    // Sau khi SCHEDULED (đã công bố) session bị khóa nội dung — chỉ
    // reschedule() cho phép đổi giờ/địa điểm.
    if (session.status !== EventSessionStatus.DRAFT) {
      throw new ApiError(
        'Only draft sessions can be updated',
        'BAD_USER_INPUT',
      );
    }

    const hasChanges = [
      input.name,
      input.venueName,
      input.venueAddress,
      input.city,
      input.countryCode,
      input.startsAt,
      input.endsAt,
      input.timezone,
      input.capacity,
    ].some((value) => value !== undefined);

    if (!hasChanges) {
      throw new ApiError(
        'At least one field must be updated',
        'BAD_USER_INPUT',
      );
    }

    const startsAt =
      input.startsAt === undefined ? session.startsAt : input.startsAt;
    const endsAt = input.endsAt === undefined ? session.endsAt : input.endsAt;

    if ((startsAt === null) !== (endsAt === null)) {
      throw new ApiError(
        'startsAt and endsAt must be provided together',
        'BAD_USER_INPUT',
      );
    }

    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new ApiError(
        'endsAt must be later than startsAt',
        'BAD_USER_INPUT',
      );
    }

    if (input.capacity !== undefined && input.capacity !== null) {
      const allocatedQuantity =
        await this.ticketTypeRepository.getTotalQuantity(input.id);

      if (allocatedQuantity > input.capacity) {
        throw new ApiError(
          'Session capacity cannot be lower than allocated ticket quantity',
          'BAD_USER_INPUT',
          {
            capacity: input.capacity,
            allocatedQuantity,
          },
        );
      }
    }

    const data: UpdateEventSessionData = {
      id: input.id,
      ownerId,
      name: input.name,
      venueName: input.venueName,
      venueAddress: input.venueAddress,
      city: input.city,
      countryCode: input.countryCode,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      capacity: input.capacity,
    };

    return this.eventsSessionRepository.update(data);
  }

  /* Đổi giờ/địa điểm của session đã công bố — operation duy nhất còn mở
     trên SCHEDULED. Phát session.rescheduled để sau này notify attendee. */
  async reschedule(input: RescheduleSessionInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const session = await this.eventsSessionRepository.findByIdAndOwner(
      input.id,
      ownerId,
    );

    if (!session) {
      throw new ApiError('Event session not found', 'NOT_FOUND');
    }

    if (
      session.event.status === EventStatus.CANCELLED ||
      session.event.status === EventStatus.ARCHIVED
    ) {
      throw new ApiError(
        'Cannot modify a session of a closed event',
        'BAD_USER_INPUT',
      );
    }

    if (session.status !== EventSessionStatus.SCHEDULED) {
      throw new ApiError(
        'Only scheduled sessions can be rescheduled',
        'BAD_USER_INPUT',
      );
    }

    const hasChanges = [
      input.startsAt,
      input.endsAt,
      input.timezone,
      input.venueName,
      input.venueAddress,
      input.city,
      input.countryCode,
    ].some((value) => value !== undefined);

    if (!hasChanges) {
      throw new ApiError(
        'At least one field must be updated',
        'BAD_USER_INPUT',
      );
    }

    const startsAt =
      input.startsAt === undefined ? session.startsAt : input.startsAt;
    const endsAt = input.endsAt === undefined ? session.endsAt : input.endsAt;

    if ((startsAt === null) !== (endsAt === null)) {
      throw new ApiError(
        'startsAt and endsAt must be provided together',
        'BAD_USER_INPUT',
      );
    }

    if (startsAt && endsAt && endsAt <= startsAt) {
      throw new ApiError(
        'endsAt must be later than startsAt',
        'BAD_USER_INPUT',
      );
    }

    const data: RescheduleSessionData = {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone,
      venueName: input.venueName,
      venueAddress: input.venueAddress,
      city: input.city,
      countryCode: input.countryCode,
    };

    const updated = await this.eventsSessionRepository.reschedule(
      input.id,
      ownerId,
      data,
    );

    this.outboxProcessor.wake();

    return updated;
  }

  async updateStatus(input: UpdateEventSessionStatusInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const session = await this.eventsSessionRepository.findByIdAndOwner(
      input.id,
      ownerId,
    );

    if (!session) {
      throw new ApiError('Event session not found', 'NOT_FOUND');
    }

    if (
      session.event.status === EventStatus.CANCELLED ||
      session.event.status === EventStatus.ARCHIVED
    ) {
      throw new ApiError(
        'Cannot modify a session of a closed event',
        'BAD_USER_INPUT',
      );
    }

    if (session.status === input.status) {
      throw new ApiError(
        'Event session is already in this status',
        'BAD_USER_INPUT',
      );
    }

    const allowedTransitions: Record<EventSessionStatus, EventSessionStatus[]> =
      {
        [EventSessionStatus.DRAFT]: [
          EventSessionStatus.SCHEDULED,
          EventSessionStatus.CANCELLED,
        ],
        [EventSessionStatus.SCHEDULED]: [
          EventSessionStatus.CANCELLED,
          EventSessionStatus.COMPLETED,
        ],
        [EventSessionStatus.CANCELLED]: [],
        [EventSessionStatus.COMPLETED]: [],
      };

    if (!allowedTransitions[session.status].includes(input.status)) {
      throw new ApiError(
        `Cannot transition from ${session.status} to ${input.status}`,
        'BAD_USER_INPUT',
      );
    }

    /* Publish session = mở bán → chỉ cho phép khi event đã PUBLISHED.
       Giữ invariant "sessionActive ⇒ event published" để inventory
       chỉ cần nghe 1 tín hiệu (session.status.changed). */
    if (
      input.status === EventSessionStatus.SCHEDULED &&
      session.event.status !== EventStatus.PUBLISHED
    ) {
      throw new ApiError(
        'Event must be published before the session can be scheduled',
        'BAD_USER_INPUT',
      );
    }

    if (
      input.status === EventSessionStatus.CANCELLED &&
      !input.cancellationReason?.trim()
    ) {
      throw new ApiError('Cancellation reason is required', 'BAD_USER_INPUT');
    }

    const updated = await this.eventsSessionRepository.updateStatus(
      input.id,
      ownerId,
      session.status,
      input.status,
      input.cancellationReason,
    );

    this.outboxProcessor.wake();

    return updated;
  }
}
