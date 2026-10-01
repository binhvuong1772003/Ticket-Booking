import { UseGuards } from '@nestjs/common';
import {
  Args,
  Context,
  ID,
  Info,
  Int,
  Mutation,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { Kind, type GraphQLResolveInfo, type SelectionSetNode } from 'graphql';
import { JwtAuthGuard } from '../../../../common/auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../../../common/auth/optional-jwt-auth.guard';
import { InternalServiceTokenGuard } from '../../../../common/auth/internal-service-token.guard';
import { AdminGuard } from '../../../../common/auth/admin.guard';
import { EventService } from '../../application/event.service';
import { EventSessionService } from '../../application/event-session.service';
import { TicketTypeService } from '../../application/ticket-type.service';
import { CreateEventInput } from './inputs/create-event.input';
import { CreateEventSessionInput } from './inputs/create-event-session.input';
import { CreateTicketTypeInput } from './inputs/create-ticket-type.input';
import { UpdateEventSessionInput } from './inputs/update-event-session.input';
import { UpdateEventSessionStatusInput } from './inputs/update-event-session-status.input';
import { RescheduleSessionInput } from './inputs/reschedule-session.input';
import { UpdateTicketTypeInput } from './inputs/update-ticket-type.input';
import { UpdateTicketTypeStatusInput } from './inputs/update-ticket-type-status.input';
import { UpdateEventInput } from './inputs/update-event.input';
import { UpdateEventStatusInput } from './inputs/update-event-status.input';
import { EventSessionModel } from './models/event-session.model';
import { TicketTypeModel } from './models/ticket-type.model';
import { EventModel } from './models/event.model';
import { TicketEventSnapshotModel } from './models/ticket-event-snapshot.model';
import { SupportedCurrencyModel } from './models/supported-currency.model';
import { EventsFilterInput } from './inputs/events-filter.input';
import { EventSessionsFilterInput } from './inputs/event-sessions-filter.input';
import { EventConnectionModel } from './models/event-connection.model';
import { EventSessionConnectionModel } from './models/event-session-connection.model';
import { TrendingService } from '../../application/trending.service';
import { TrendingEventModel } from './models/trending-event.model';

type GraphQLContext = {
  req: {
    user?: {
      sub: string;
      role?: string;
    };
  };
};

function hasSelectedField(
  info: GraphQLResolveInfo,
  fieldName: string,
): boolean {
  const visitedFragments = new Set<string>();
  const visit = (selectionSet?: SelectionSetNode): boolean => {
    for (const selection of selectionSet?.selections ?? []) {
      if (selection.kind === Kind.FIELD) {
        if (selection.name.value === fieldName || visit(selection.selectionSet)) {
          return true;
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (visit(selection.selectionSet)) return true;
      } else if (
        selection.kind === Kind.FRAGMENT_SPREAD &&
        !visitedFragments.has(selection.name.value)
      ) {
        visitedFragments.add(selection.name.value);
        if (visit(info.fragments[selection.name.value]?.selectionSet)) {
          return true;
        }
      }
    }
    return false;
  };

  return info.fieldNodes.some((node) => visit(node.selectionSet));
}

@Resolver(() => EventModel)
export class EventsResolver {
  constructor(
    private readonly eventService: EventService,
    private readonly eventSessionService: EventSessionService,
    private readonly ticketTypeService: TicketTypeService,
    private readonly trendingService: TrendingService,
  ) {}

  @Query(() => [EventModel])
  events(@Info() info?: GraphQLResolveInfo) {
    return this.eventService.findPublished(
      info ? hasSelectedField(info, 'availability') : false,
    );
  }

  @Query(() => EventConnectionModel)
  eventsPage(
    @Args('first', { type: () => Int, defaultValue: 20 }) first: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
    @Args('filter', { nullable: true }) filter?: EventsFilterInput,
    @Info() info?: GraphQLResolveInfo,
  ) {
    const includeSessions = info ? hasSelectedField(info, 'sessions') : false;
    const includeSummary = info
      ? ['nextSession', 'priceFrom', 'currency', 'availability'].some((field) =>
          hasSelectedField(info, field),
        )
      : false;
    return this.eventService.findPublishedPage({
      first,
      after,
      filter,
      includeSessions,
      includeSummary,
    });
  }

  @Query(() => [EventModel])
  featuredEvents(
    @Args('city', { type: () => String, nullable: true }) city?: string,
    @Args('first', { type: () => Int, defaultValue: 10 }) first = 10,
  ) {
    return this.eventService.findFeaturedEvents({ city, first });
  }

  @Query(() => [TrendingEventModel])
  trendingEvents(
    @Args('city', { type: () => String, nullable: true }) city?: string,
    @Args('first', { type: () => Int, defaultValue: 10 }) first = 10,
  ) {
    return this.trendingService.findTrendingEvents({ city, first });
  }

  @UseGuards(AdminGuard)
  @Mutation(() => EventModel)
  setEventFeatured(
    @Args('eventId', { type: () => ID }) eventId: string,
    @Args('featuredOrder', { type: () => Int, nullable: true })
    featuredOrder: number | null = null,
  ) {
    return this.eventService.setEventFeatured(eventId, featuredOrder);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Query(() => EventSessionConnectionModel)
  eventSessions(
    @Args('eventId', { type: () => ID }) eventId: string,
    @Args('first', { type: () => Int, defaultValue: 20 }) first: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
    @Args('filter', { nullable: true }) filter?: EventSessionsFilterInput,
    @Context() context?: GraphQLContext,
  ) {
    return this.eventService.findSessionsPage(
      { eventId, first, after, filter },
      context?.req.user,
    );
  }

  /* Catalog currency mà payment layer hỗ trợ — public, dùng cho dropdown
     lúc tạo session và để client biết minorUnit khi format giá. */
  @Query(() => [SupportedCurrencyModel])
  supportedCurrencies() {
    return this.eventSessionService.listSupportedCurrencies();
  }

  @UseGuards(JwtAuthGuard)
  @Query(() => [EventModel])
  myEvents(@Context() context: GraphQLContext) {
    return this.eventService.findByOwner(context.req.user!.sub);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Query(() => EventModel)
  event(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ) {
    return this.eventService.findById(id, context.req.user);
  }

  @UseGuards(InternalServiceTokenGuard)
  @Query(() => TicketEventSnapshotModel)
  ticketSnapshot(
    @Args('eventId', { type: () => ID }) eventId: string,
    @Args('sessionId', { type: () => ID }) sessionId: string,
  ) {
    return this.eventService.getTicketSnapshot(eventId, sessionId);
  }

  /* Any signed-in user may create an event; update/status mutations enforce
     ownership via ownerId in the service layer (organizer role not yet
     implemented). */
  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventModel)
  createEvent(
    @Args('input') input: CreateEventInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventService.create(input, context.req.user!.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventModel)
  updateEvent(
    @Args('input') input: UpdateEventInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventService.update(input, context.req.user!.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventModel)
  updateEventStatus(
    @Args('input') input: UpdateEventStatusInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventService.updateStatus(input, context.req.user!.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventSessionModel)
  createEventSession(
    @Args('input') input: CreateEventSessionInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventSessionService.create(input, context.req.user!.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventSessionModel)
  updateEventSession(
    @Args('input') input: UpdateEventSessionInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventSessionService.update(input, context.req.user!.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventSessionModel)
  updateEventSessionStatus(
    @Args('input') input: UpdateEventSessionStatusInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventSessionService.updateStatus(input, context.req.user!.sub);
  }

  /* Đổi giờ/địa điểm sau khi session đã công bố — mutation duy nhất còn
     mở trên SCHEDULED (updateEventSession chỉ áp dụng cho DRAFT). */
  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventSessionModel)
  rescheduleSession(
    @Args('input') input: RescheduleSessionInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventSessionService.reschedule(input, context.req.user!.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => TicketTypeModel)
  createTicketType(
    @Args('input') input: CreateTicketTypeInput,
    @Context() context: GraphQLContext,
  ) {
    return this.ticketTypeService.create(input, context.req.user!.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => TicketTypeModel)
  updateTicketType(
    @Args('input') input: UpdateTicketTypeInput,
    @Context() context: GraphQLContext,
  ) {
    return this.ticketTypeService.update(input, context.req.user!.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => TicketTypeModel)
  updateTicketTypeStatus(
    @Args('input') input: UpdateTicketTypeStatusInput,
    @Context() context: GraphQLContext,
  ) {
    return this.ticketTypeService.updateStatus(input, context.req.user!.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => TicketTypeModel)
  deleteTicketType(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ) {
    return this.ticketTypeService.remove(id, context.req.user!.sub);
  }

  /* Organizer chủ động hoàn 1 vé đã bán. Ownership check ở service layer
     (findByIdAndOwner) giống update/updateStatus; refund thực thi async
     qua Kafka 'booking.refund.requested'. Trả true = request đã ghi. */
  @UseGuards(JwtAuthGuard)
  @Mutation(() => Boolean)
  refundTicket(
    @Args('eventId', { type: () => ID }) eventId: string,
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @Args('reason', { type: () => String, nullable: true })
    reason: string | undefined,
    @Context() context: GraphQLContext,
  ) {
    return this.eventService.requestBookingRefund(
      { eventId, bookingId, reason },
      context.req.user!.sub,
    );
  }
}
