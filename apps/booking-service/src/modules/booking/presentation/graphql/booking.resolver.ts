import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { BookingService } from '../../application/booking.service';
import { CreateBookingInput } from './inputs/create-booking.input';
import { BookingModel } from './models/booking.model';
import { JwtAuthGuard } from '../../../../common/auth/jwt-auth.guard';

type GraphQLContext = {
  req: {
    user: {
      sub: string;
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
}
