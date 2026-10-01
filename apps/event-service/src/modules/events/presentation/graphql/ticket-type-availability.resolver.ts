import { Context, Int, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { TicketTypeModel } from './models/ticket-type.model';
import { InventoryAvailabilityClient } from '../../infrastructure/inventory-availability.client';
import { requestTicketAvailabilityLoader } from '../../infrastructure/ticket-availability.loader';
import type { TicketAvailabilityContext } from '../../infrastructure/ticket-availability.loader';

@Resolver(() => TicketTypeModel)
export class TicketTypeAvailabilityResolver {
  constructor(private readonly inventoryClient: InventoryAvailabilityClient) {}

  @ResolveField(() => Int, { nullable: true })
  availableQuantity(
    @Parent() ticketType: TicketTypeModel,
    @Context() context: TicketAvailabilityContext,
  ) {
    return requestTicketAvailabilityLoader(context, this.inventoryClient).load(
      ticketType.id,
      ticketType.sessionId,
    );
  }
}
