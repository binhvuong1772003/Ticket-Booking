import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { JwtAuthGuard } from '../../../../common/auth/jwt-auth.guard';
import { EventsService } from '../../application/events.service';
import { CreateEventInput } from './inputs/create-event.input';
import { CreateEventSessionInput } from './inputs/create-event-session.input';
import { UpdateEventSessionInput } from './inputs/update-event-session.input';
import { UpdateEventSessionStatusInput } from './inputs/update-event-session-status.input';
import { UpdateEventInput } from './inputs/update-event.input';
import { UpdateEventStatusInput } from './inputs/update-event-status.input';
import { EventSessionModel } from './models/event-session.model';
import { EventModel } from './models/event.model';

type GraphQLContext = {
  req: {
    user: {
      sub: string;
    };
  };
};

@Resolver(() => EventModel)
export class EventsResolver {
  constructor(private readonly eventsService: EventsService) {}

  @Query(() => [EventModel])
  events() {
    return this.eventsService.findPublished();
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventModel)
  createEvent(
    @Args('input') input: CreateEventInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventsService.create(input, context.req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventModel)
  updateEvent(
    @Args('input') input: UpdateEventInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventsService.update(input, context.req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventModel)
  updateEventStatus(
    @Args('input') input: UpdateEventStatusInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventsService.updateStatus(input, context.req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventSessionModel)
  createEventSession(
    @Args('input') input: CreateEventSessionInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventsService.createEventSession(input, context.req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventSessionModel)
  updateEventSession(
    @Args('input') input: UpdateEventSessionInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventsService.updateEventSession(input, context.req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => EventSessionModel)
  updateEventSessionStatus(
    @Args('input') input: UpdateEventSessionStatusInput,
    @Context() context: GraphQLContext,
  ) {
    return this.eventsService.updateEventSessionStatus(
      input,
      context.req.user.sub,
    );
  }
}
