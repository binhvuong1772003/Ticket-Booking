export type TicketIssuedEvent = {
  eventId: string;
  eventType: 'ticket.issued';
  occurredAt: string;
  payload: {
    booking_id: string;
    user_id: string;
    event_id: string;
    session_id: string;
    tickets: {
      ticket_id: string;
      ordinal: number;
      template_version: number;
      render_revision: number;
    }[];
  };
};
