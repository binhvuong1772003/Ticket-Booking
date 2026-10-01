import { describe, expect, it, vi } from 'vitest';
import { parse, type FieldNode, type GraphQLResolveInfo } from 'graphql';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';
import { EventsResolver } from './events.resolver';
import { EventService } from '../../application/event.service';
import { EventSessionService } from '../../application/event-session.service';
import { TicketTypeService } from '../../application/ticket-type.service';
import { AdminGuard } from '../../../../common/auth/admin.guard';
import { TrendingService } from '../../application/trending.service';

function eventPageInfo(query: string) {
  const document = parse(query);
  const field = document.definitions[0];
  if (field.kind !== 'OperationDefinition') {
    throw new Error('Expected a query operation');
  }
  return {
    fieldNodes: field.selectionSet.selections as FieldNode[],
    fragments: Object.fromEntries(
      document.definitions
        .filter((definition) => definition.kind === 'FragmentDefinition')
        .map((fragment) => [fragment.name.value, fragment]),
    ),
  } as unknown as GraphQLResolveInfo;
}

describe('EventsResolver.eventsPage field selection', () => {
  const findPublishedPage = vi.fn().mockResolvedValue({ nodes: [], pageInfo: {} });
  const resolver = new EventsResolver(
    { findPublishedPage } as unknown as EventService,
    {} as EventSessionService,
    {} as TicketTypeService,
    { findTrendingEvents: vi.fn() } as unknown as TrendingService,
  );

  it('loads only the one-session summary when a card summary is selected', () => {
    resolver.eventsPage(
      10,
      undefined,
      undefined,
      eventPageInfo('query { eventsPage { nodes { nextSession { id } } } }'),
    );

    expect(findPublishedPage).toHaveBeenCalledWith(
      expect.objectContaining({ includeSummary: true, includeSessions: false }),
    );
  });

  it('loads the legacy session collection when it is selected through a fragment', () => {
    resolver.eventsPage(
      10,
      undefined,
      undefined,
      eventPageInfo(
        'query { eventsPage { nodes { ...LegacyFields } } } fragment LegacyFields on Event { sessions { id } }',
      ),
    );

    expect(findPublishedPage).toHaveBeenCalledWith(
      expect.objectContaining({ includeSessions: true }),
    );
  });
});

describe('EventsResolver.events availability selection', () => {
  const findPublished = vi.fn().mockResolvedValue([]);
  const resolver = new EventsResolver(
    { findPublished } as unknown as EventService,
    {} as EventSessionService,
    {} as TicketTypeService,
    { findTrendingEvents: vi.fn() } as unknown as TrendingService,
  );

  it('loads session summary only when availability is selected', () => {
    resolver.events(
      eventPageInfo('query { events { id availability } }'),
    );

    expect(findPublished).toHaveBeenCalledWith(true);
  });

  it('keeps the existing lightweight query when availability is not selected', () => {
    resolver.events(eventPageInfo('query { events { id title } }'));

    expect(findPublished).toHaveBeenCalledWith(false);
  });
});

describe('EventsResolver featured discovery', () => {
  const findFeaturedEvents = vi.fn();
  const setEventFeatured = vi.fn();
  const resolver = new EventsResolver(
    { findFeaturedEvents, setEventFeatured } as unknown as EventService,
    {} as EventSessionService,
    {} as TicketTypeService,
    { findTrendingEvents: vi.fn() } as unknown as TrendingService,
  );

  it('exposes a public featuredEvents query with city and limit filters', () => {
    resolver.featuredEvents('Hanoi', 3);

    expect(findFeaturedEvents).toHaveBeenCalledWith({ first: 3, city: 'Hanoi' });
  });

  it('routes featured changes through an AdminGuard-protected mutation', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      EventsResolver.prototype,
      'setEventFeatured',
    );
    expect(descriptor).toBeDefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, descriptor?.value)).toContain(
      AdminGuard,
    );

    resolver.setEventFeatured('64b64c0000000000000000e1', 0);
    expect(setEventFeatured).toHaveBeenCalledWith(
      '64b64c0000000000000000e1',
      0,
    );
  });
});

describe('EventsResolver trending discovery', () => {
  const findTrendingEvents = vi.fn();
  const resolver = new EventsResolver(
    {} as EventService,
    {} as EventSessionService,
    {} as TicketTypeService,
    { findTrendingEvents } as unknown as TrendingService,
  );

  it('exposes public ranked events with city and first filters', () => {
    resolver.trendingEvents('Hanoi', 5);
    expect(findTrendingEvents).toHaveBeenCalledWith({ first: 5, city: 'Hanoi' });
    const descriptor = Object.getOwnPropertyDescriptor(
      EventsResolver.prototype,
      'trendingEvents',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, descriptor?.value) ?? []).toEqual(
      [],
    );
  });
});
