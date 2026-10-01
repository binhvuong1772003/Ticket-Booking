import { EventSessionStatus } from '@prisma/client';
import { Context, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { EventAvailability, EventModel } from './models/event.model';
import { InventoryAvailabilityClient } from '../../infrastructure/inventory-availability.client';
import { requestTicketAvailabilityLoader } from '../../infrastructure/ticket-availability.loader';
import type { TicketAvailabilityContext } from '../../infrastructure/ticket-availability.loader';

@Resolver(() => EventModel)
export class EventAvailabilityResolver {
  constructor(private readonly inventoryClient: InventoryAvailabilityClient) {}

  @ResolveField(() => EventAvailability, { nullable: true })
  async availability(
    @Parent() event: EventModel,
    @Context() context: TicketAvailabilityContext,
  ) {
    if (event.status === 'CANCELLED') return EventAvailability.CANCELLED;
    const now = new Date();
    const sessions = event.sessions ?? [];
    const session =
      event.nextSession ??
      sessions
        .filter(
          (item) =>
            item.status === EventSessionStatus.SCHEDULED &&
            item.startsAt != null &&
            item.startsAt > now,
        )
        .sort(
          (a, b) =>
            a.startsAt!.getTime() - b.startsAt!.getTime() ||
            a.id.localeCompare(b.id),
        )[0];

    if (!session) {
      if (
        sessions.length &&
        sessions.every((item) => item.status === EventSessionStatus.CANCELLED)
      ) {
        return EventAvailability.CANCELLED;
      }
      if (sessions.some((item) => item.status === EventSessionStatus.DRAFT)) {
        return EventAvailability.NOT_ON_SALE;
      }
      if (sessions.length) return EventAvailability.ENDED;
      return event.status === 'PUBLISHED'
        ? EventAvailability.NOT_ON_SALE
        : null;
    }

    const ticketTypes = (session.ticketTypes ?? []).filter(
      (ticketType) => ticketType.status === 'ACTIVE',
    );
    if (!ticketTypes.length) return EventAvailability.NOT_ON_SALE;

    const quantities = await Promise.all(
      ticketTypes.map((ticketType) =>
        requestTicketAvailabilityLoader(context, this.inventoryClient).load(
          ticketType.id,
          ticketType.sessionId,
        ),
      ),
    );
    if (quantities.some((quantity) => quantity > 0)) {
      return EventAvailability.AVAILABLE;
    }
    if (
      ticketTypes.some(
        (ticketType) => ticketType.salesStartAt && ticketType.salesStartAt > now,
      )
    ) {
      return EventAvailability.NOT_ON_SALE;
    }
    return EventAvailability.SOLD_OUT;
  }
}
