import { Injectable } from '@nestjs/common';
import { EventSessionStatus, EventStatus } from '@prisma/client';
import { CreateEventInput } from '../presentation/graphql/inputs/create-event.input';
import { UpdateEventInput } from '../presentation/graphql/inputs/update-event.input';
import { UpdateEventStatusInput } from '../presentation/graphql/inputs/update-event-status.input';
import {
  CreateEventData,
  EventsRepository,
  UpdateEventData,
} from '../infrastructure/events.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';
import { EventsSessionRepository } from '../infrastructure/event-session.repository';
import { ApiError } from '../../../common/errors/api-error';

const allowedTransitions: Record<EventStatus, EventStatus[]> = {
  [EventStatus.DRAFT]: [EventStatus.PUBLISHED, EventStatus.CANCELLED],
  [EventStatus.PUBLISHED]: [EventStatus.CANCELLED, EventStatus.ARCHIVED],
  [EventStatus.CANCELLED]: [],
  [EventStatus.ARCHIVED]: [],
};

@Injectable()
export class EventService {
  constructor(
    private readonly eventsRepository: EventsRepository,
    private readonly eventsSessionRepository: EventsSessionRepository,
    private readonly outbox: OutboxProcessor,
  ) {}

  findPublished() {
    return this.eventsRepository.findPublished();
  }

  findByOwner(ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }
    return this.eventsRepository.findByOwner(ownerId);
  }

  async findById(id: string, viewer?: { sub: string; role?: string }) {
    if (!/^[0-9a-f]{24}$/i.test(id)) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    const event = await this.eventsRepository.findById(id);
    if (!event) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    const isOwner = event.ownerId === viewer?.sub || viewer?.role === 'ADMIN';
    const canView = event.status === EventStatus.PUBLISHED || isOwner;

    if (!canView) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    // Session DRAFT là bản nháp nội bộ — chỉ owner/admin nhìn thấy.
    if (!isOwner && event.sessions) {
      event.sessions = event.sessions.filter(
        (session) => session.status !== EventSessionStatus.DRAFT,
      );
    }

    return event;
  }

  create(input: CreateEventInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const data: CreateEventData = {
      title: input.title,
      slug: input.slug,
      summary: input.summary,
      organizerDisplayName: input.organizerDisplayName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      coverImageUrl: input.coverImageUrl,
      ownerId,
    };

    return this.eventsRepository.create(data);
  }

  update(input: UpdateEventInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const hasChanges = [
      input.title,
      input.slug,
      input.summary,
      input.organizerDisplayName,
      input.contactEmail,
      input.contactPhone,
      input.coverImageUrl,
    ].some((value) => value !== undefined);

    if (!hasChanges) {
      throw new ApiError(
        'At least one field must be updated',
        'BAD_USER_INPUT',
      );
    }

    const data: UpdateEventData = {
      id: input.id,
      title: input.title,
      slug: input.slug,
      summary: input.summary,
      organizerDisplayName: input.organizerDisplayName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      coverImageUrl: input.coverImageUrl,
      ownerId,
    };

    return this.eventsRepository.update(data);
  }

  async updateStatus(input: UpdateEventStatusInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const event = await this.eventsRepository.findByIdAndOwner(
      input.id,
      ownerId,
    );

    if (!event) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    if (event.status === input.status) {
      throw new ApiError('Event is already in this status', 'BAD_USER_INPUT');
    }

    if (
      input.status === EventStatus.CANCELLED &&
      !input.cancellationReason?.trim()
    ) {
      throw new ApiError('Cancellation reason is required', 'BAD_USER_INPUT');
    }

    const allowed = allowedTransitions[event.status];
    if (!allowed.includes(input.status)) {
      throw new ApiError(
        `Cannot transition from ${event.status} to ${input.status}`,
        'BAD_USER_INPUT',
      );
    }

    /* ARCHIVED không cascade session — nếu archive khi còn session đang
       mở thì inventory không nhận được session.status.changed, vé vẫn
       bán được. Chặn: archive chỉ là housekeeping sau khi mọi session đã
       COMPLETED/CANCELLED. */
    if (input.status === EventStatus.ARCHIVED) {
      const liveSessions = await this.eventsSessionRepository.countLiveSessions(
        input.id,
      );
      if (liveSessions > 0) {
        throw new ApiError(
          'Cannot archive an event with draft or scheduled sessions — complete or cancel them first',
          'BAD_USER_INPUT',
          { liveSessions },
        );
      }
    }

    const updated = await this.eventsRepository.updateStatus(
      input.id,
      ownerId,
      event.status,
      input.status,
      input.cancellationReason,
      event.version,
    );
    if (
      input.status === EventStatus.CANCELLED ||
      input.status === EventStatus.PUBLISHED
    ) {
      this.outbox.wake();
    }
    return updated;
  }

  /**
   * Organizer chủ động hoàn 1 booking. Ownership check qua
   * findByIdAndOwner — chỉ owner mới phát được lệnh. Thực thi async:
   * booking-service consume 'booking.refund.requested', verify
   * booking.eventId khớp event_id rồi mới refund.
   */
  async requestBookingRefund(
    input: { eventId: string; bookingId: string; reason?: string },
    ownerId: string,
  ) {
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

    await this.eventsRepository.emitRefundRequest({
      eventId: event.id,
      aggregateVersion: event.version,
      bookingId: input.bookingId,
      reason: input.reason,
      requestedBy: ownerId,
    });
    this.outbox.wake();
    return true;
  }
}
