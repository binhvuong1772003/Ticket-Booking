import { Args, Context, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { BookingService } from '../../application/booking.service';
import { CreateBookingInput } from './inputs/create-booking.input';
import { BookingModel } from './models/booking.model';
import { JwtAuthGuard } from '../../../../common/auth/jwt-auth.guard';

type GraphQLContext = {
  req: {
    user: {
      sub: string;
      role?: string;
    };
  };
};

@Resolver(() => BookingModel)
export class BookingResolver {
  constructor(private readonly bookingService: BookingService) {}

  @UseGuards(JwtAuthGuard)
  @Mutation(() => BookingModel)
  createBooking(
    @Args('input') input: CreateBookingInput,
    @Context() context: GraphQLContext,
  ) {
    return this.bookingService.create(input, context.req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Query(() => [BookingModel])
  myBookings(@Context() context: GraphQLContext) {
    return this.bookingService.myBookings(context.req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Query(() => BookingModel)
  booking(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ) {
    return this.bookingService.booking(id, context.req.user);
  }

  /* Danh sách vé đã đặt của 1 event — chỉ organizer sở hữu event
     (verify qua EventCatalog projection từ event.published). */
  @UseGuards(JwtAuthGuard)
  @Query(() => [BookingModel])
  eventBookings(
    @Args('eventId', { type: () => ID }) eventId: string,
    @Context() context: GraphQLContext,
  ) {
    return this.bookingService.eventBookings(eventId, context.req.user);
  }

  @UseGuards(JwtAuthGuard)
  @Query(() => [BookingModel])
  sessionBookings(
    @Args('sessionId', { type: () => ID }) sessionId: string,
    @Context() context: GraphQLContext,
  ) {
    return this.bookingService.sessionBookings(sessionId, context.req.user);
  }
}
