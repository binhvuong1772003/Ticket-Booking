import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { TicketTypeService } from './ticket-type.service';
import { TicketTypeRepository } from '../infrastructure/ticket-type.repository';
import { EventsSessionRepository } from '../infrastructure/event-session.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';

const draftSession = {
  id: 's1',
  status: 'DRAFT',
  capacity: 100,
  event: { status: 'PUBLISHED' },
};

const scheduledSession = { ...draftSession, status: 'SCHEDULED' };

const ticketType = {
  id: 'tt1',
  sessionId: 's1',
  name: 'VIP',
  code: 'VIP',
  price: 100,
  currency: 'USD',
  quantity: 50,
  status: 'ACTIVE',
  session: {
    status: 'DRAFT',
    capacity: 100,
    event: { status: 'PUBLISHED' },
  },
};

describe('TicketTypeService', () => {
  let service: TicketTypeService;
  const findSessionByIdAndOwner = vi.fn();
  const findTicketTypeByIdAndOwner = vi.fn();
  const getTotalQuantity = vi.fn();
  const createWithOutbox = vi.fn();
  const updateWithOutbox = vi.fn();
  const deleteWithOutbox = vi.fn();
  const wake = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    getTotalQuantity.mockResolvedValue(50);
    updateWithOutbox.mockImplementation((id, data) => ({
      ...ticketType,
      ...data,
    }));
    deleteWithOutbox.mockResolvedValue(ticketType);
    createWithOutbox.mockResolvedValue(ticketType);

    const module = await Test.createTestingModule({
      providers: [
        TicketTypeService,
        {
          provide: EventsSessionRepository,
          useValue: { findByIdAndOwner: findSessionByIdAndOwner },
        },
        {
          provide: TicketTypeRepository,
          useValue: {
            findByIdAndOwner: findTicketTypeByIdAndOwner,
            getTotalQuantity,
            createWithOutbox,
            updateWithOutbox,
            deleteWithOutbox,
          },
        },
        { provide: OutboxProcessor, useValue: { wake } },
      ],
    }).compile();
    service = module.get(TicketTypeService);
  });

  it('creates ticket type on draft session', async () => {
    findSessionByIdAndOwner.mockResolvedValue(draftSession);
    const result = await service.create(
      {
        sessionId: 's1',
        name: 'VIP',
        code: 'VIP',
        price: 100,
        quantity: 50,
      },
      'u1',
    );
    expect(result).toBe(ticketType);
    expect(createWithOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ sessionStatus: 'DRAFT' }),
    );
    expect(wake).toHaveBeenCalled();
  });

  it('rejects create once session is scheduled', async () => {
    findSessionByIdAndOwner.mockResolvedValue(scheduledSession);
    await expect(
      service.create(
        { sessionId: 's1', name: 'VIP', code: 'VIP', price: 100, quantity: 50 },
        'u1',
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(createWithOutbox).not.toHaveBeenCalled();
  });

  it('updates ticket type while session is draft', async () => {
    findTicketTypeByIdAndOwner.mockResolvedValue(ticketType);
    const result = await service.update({ id: 'tt1', price: 200 }, 'u1');
    expect(updateWithOutbox).toHaveBeenCalledWith('tt1', { price: 200 });
    expect(result.price).toBe(200);
  });

  it('rejects update once session is scheduled', async () => {
    findTicketTypeByIdAndOwner.mockResolvedValue({
      ...ticketType,
      session: { ...ticketType.session, status: 'SCHEDULED' },
    });
    await expect(
      service.update({ id: 'tt1', price: 200 }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(updateWithOutbox).not.toHaveBeenCalled();
  });

  it('rejects quantity increase beyond session capacity', async () => {
    findTicketTypeByIdAndOwner.mockResolvedValue(ticketType);
    getTotalQuantity.mockResolvedValue(90);
    await expect(
      service.update({ id: 'tt1', quantity: 61 }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(updateWithOutbox).not.toHaveBeenCalled();
  });

  it('allows INACTIVE toggle on scheduled session', async () => {
    findTicketTypeByIdAndOwner.mockResolvedValue({
      ...ticketType,
      session: { ...ticketType.session, status: 'SCHEDULED' },
    });
    await service.updateStatus(
      { id: 'tt1', status: 'INACTIVE' as never },
      'u1',
    );
    expect(updateWithOutbox).toHaveBeenCalledWith('tt1', {
      status: 'INACTIVE',
    });
  });

  it('rejects manual SOLD_OUT', async () => {
    await expect(
      service.updateStatus({ id: 'tt1', status: 'SOLD_OUT' as never }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(findTicketTypeByIdAndOwner).not.toHaveBeenCalled();
  });

  it('deletes ticket type while session is draft', async () => {
    findTicketTypeByIdAndOwner.mockResolvedValue(ticketType);
    await service.remove('tt1', 'u1');
    expect(deleteWithOutbox).toHaveBeenCalledWith('tt1');
    expect(wake).toHaveBeenCalled();
  });

  it('rejects delete once session is scheduled', async () => {
    findTicketTypeByIdAndOwner.mockResolvedValue({
      ...ticketType,
      session: { ...ticketType.session, status: 'SCHEDULED' },
    });
    await expect(service.remove('tt1', 'u1')).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    expect(deleteWithOutbox).not.toHaveBeenCalled();
  });

  it('rejects non-owner access', async () => {
    findTicketTypeByIdAndOwner.mockResolvedValue(null);
    await expect(
      service.update({ id: 'tt1', price: 1 }, 'stranger'),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });
});
