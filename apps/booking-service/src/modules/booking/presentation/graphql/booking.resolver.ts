import {
  Args,
  Context,
  GraphQLISODateTime,
  ID,
  Int,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { BookingService } from '../../application/booking.service';
import { CreateBookingInput } from './inputs/create-booking.input';
import { BookingModel } from './models/booking.model';
import { JwtAuthGuard } from '../../../../common/auth/jwt-auth.guard';
import { BookingInternalServiceTokenGuard } from '../../../../common/auth/booking-internal-service-token.guard';
import { TicketBookingItemSnapshotModel } from './models/ticket-booking-item-snapshot.model';
import { BookingTrendingSalesConnectionModel } from './models/booking-trending-sales.model';
import { BookingRecipientModel } from './models/booking-recipient.model';

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

  @ResolveField(() => String, { nullable: true })
  recipientFullName(
    @Parent() booking: BookingModel,
    @Context() context: GraphQLContext,
  ) {
    return booking.userId === context.req.user.sub || context.req.user.role === 'ADMIN'
      ? booking.recipientFullName ?? null
      : null;
  }

  @ResolveField(() => String, { nullable: true })
  recipientEmail(
    @Parent() booking: BookingModel,
    @Context() context: GraphQLContext,
  ) {
    return booking.userId === context.req.user.sub || context.req.user.role === 'ADMIN'
      ? booking.recipientEmail ?? null
      : null;
  }

  @UseGuards(BookingInternalServiceTokenGuard)
  @Query(() => TicketBookingItemSnapshotModel)
  ticketBookingItemSnapshot(@Args('bookingItemId', { type: () => String }) bookingItemId: string) {
    return this.bookingService.ticketBookingItemSnapshot(bookingItemId);
  }

  @UseGuards(BookingInternalServiceTokenGuard)
  @Query(() => BookingTrendingSalesConnectionModel)
  internalTrendingSales(
    @Args('since', { type: () => GraphQLISODateTime }) since: Date,
    @Args('first', { type: () => Int, defaultValue: 100 }) first = 100,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ) {
    return this.bookingService.internalTrendingSalesPage({ since, first, after });
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => BookingModel)
  createBooking(
    @Args('input') input: CreateBookingInput,
    @Context() context: GraphQLContext,
  ) {
    return this.bookingService.create(input, context.req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => BookingModel)
  updateBookingContact(
    @Args('bookingId', { type: () => ID }) bookingId: string,
    @Args('fullName') fullName: string,
    @Args('email') email: string,
    @Context() context: GraphQLContext,
  ) {
    return this.bookingService.updateBookingContact(
      bookingId,
      { fullName, email },
      context.req.user.sub,
    );
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

  @UseGuards(BookingInternalServiceTokenGuard)
  @Query(() => BookingRecipientModel)
  internalBookingRecipient(
    @Args('bookingId', { type: () => ID }) bookingId: string,
  ) {
    return this.bookingService.internalBookingRecipient(bookingId);
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
