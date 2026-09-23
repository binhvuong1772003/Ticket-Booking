import { UseGuards } from '@nestjs/common';
import { Args, Context, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { JwtAuthGuard } from '../../../../common/auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../../../common/auth/optional-jwt-auth.guard';
import { EventService } from '../../application/event.service';
import { EventSessionService } from '../../application/event-session.service';
import { TicketTypeService } from '../../application/ticket-type.service';
import { CreateEventInput } from './inputs/create-event.input';
import { CreateEventSessionInput } from './inputs/create-event-session.input';
import { CreateTicketTypeInput } from './inputs/create-ticket-type.input';
import { UpdateEventSessionInput } from './inputs/update-event-session.input';
import { UpdateEventSessionStatusInput } from './inputs/update-event-session-status.input';
import { UpdateEventInput } from './inputs/update-event.input';
import { UpdateEventStatusInput } from './inputs/update-event-status.input';
import { EventSessionModel } from './models/event-session.model';
import { TicketTypeModel } from './models/ticket-type.model';
import { EventModel } from './models/event.model';

type GraphQLContext = {
  req: {
    user?: {
      sub: string;
      role?: string;
    };
  };
};

@Resolver(() => EventModel)
export class EventsResolver {
  constructor(
    private readonly eventService: EventService,
    private readonly eventSessionService: EventSessionService,
    private readonly ticketTypeService: TicketTypeService,
  ) {}

  @Query(() => [EventModel])
  events() {
    return this.eventService.findPublished();
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

  @UseGuards(JwtAuthGuard)
  @Mutation(() => TicketTypeModel)
  createTicketType(
    @Args('input') input: CreateTicketTypeInput,
    @Context() context: GraphQLContext,
  ) {
    return this.ticketTypeService.create(input, context.req.user!.sub);
  }
}
