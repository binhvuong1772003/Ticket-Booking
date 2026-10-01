import { HttpException, UseGuards } from '@nestjs/common';
import { Args, Context, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { validateSync } from 'class-validator';
import { JwtAuthGuard } from '../../../../common/auth/jwt-auth.guard';
import { TicketCheckInService } from '../../application/ticket-checkin.service';
import { TicketQueryService } from '../../application/ticket-query.service';
import { TicketEmailClient } from '../../infrastructure/ticket-email.client';
import { TicketCheckInInput } from './ticket.inputs';
import { MyTicketDetail, MyTicketPage, TicketCheckInPayload, TicketEmailResendPayload } from './ticket.models';

type GraphQLContext = { req: { user: { sub: string } } };

@Resolver()
export class TicketResolver {
  constructor(
    private readonly tickets: TicketQueryService,
    private readonly checkIn: TicketCheckInService,
    private readonly email: TicketEmailClient,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Query(() => MyTicketPage)
  myTickets(
    @Args('first', { type: () => Int, nullable: true, defaultValue: 20 }) first: number | null,
    @Args('after', { type: () => String, nullable: true }) after: string | null,
    @Context() context: GraphQLContext,
  ) {
    if (first === null || !Number.isInteger(first) || first < 1 || first > 100) {
      throw new GraphQLError('first must be an integer from 1 to 100', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    return this.mapErrors(() => this.tickets.listOwnedTickets(context.req.user.sub, after ?? '', first));
  }

  @UseGuards(JwtAuthGuard)
  @Query(() => MyTicketDetail)
  myTicket(@Args('id', { type: () => ID }) id: string, @Context() context: GraphQLContext) {
    return this.mapErrors(() => this.tickets.getOwnedTicket(context.req.user.sub, id));
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => TicketEmailResendPayload)
  resendTicketEmail(@Args('ticketId', { type: () => ID }) ticketId: string, @Context() context: GraphQLContext) {
    return this.mapErrors(() => this.email.resend(context.req.user.sub, ticketId));
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => TicketCheckInPayload)
  checkInTicket(@Args('input') input: TicketCheckInInput, @Context() context: GraphQLContext) {
    const errors = validateSync(Object.assign(new TicketCheckInInput(), input), { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) throw new GraphQLError('Invalid check-in input', { extensions: { code: 'BAD_USER_INPUT' } });
    return this.mapErrors(() => this.checkIn.checkInTicket({
      scannerId: context.req.user.sub,
      sessionId: input.sessionId,
      qrToken: input.qrToken,
      requestId: input.requestId,
      gateId: input.gateId ?? undefined,
    }));
  }

  private async mapErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof HttpException)) {
        throw new GraphQLError('Internal server error', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
      }
      const response = error.getResponse();
      const responseCode = typeof response === 'object' && response !== null && 'code' in response
        ? response.code : undefined;
      if (responseCode === 'TICKET_PREPARING') {
        throw new GraphQLError('Ticket is still being prepared', { extensions: { code: 'TICKET_PREPARING' } });
      }
      const code = new Map<number, string>([
        [400, 'BAD_USER_INPUT'], [401, 'UNAUTHENTICATED'], [403, 'FORBIDDEN'],
        [404, 'NOT_FOUND'], [409, 'CONFLICT'], [429, 'TOO_MANY_REQUESTS'], [503, 'SERVICE_UNAVAILABLE'],
      ]).get(error.getStatus());
      throw new GraphQLError(code ? error.message : 'Internal server error', {
        extensions: { code: code ?? 'INTERNAL_SERVER_ERROR' },
      });
    }
  }
}
