import { describe, expect, it } from 'vitest';
import { EmailTemplate } from './email.template';

describe('EmailTemplate.ticketIssued', () => {
  const template = new EmailTemplate();

  it('escapes user controlled content and references images by CID without embedding credentials', () => {
    const html = template.ticketIssued(
      '<img src=x onerror=alert(1)>',
      'booking<&>',
      [{ ticketId: 'ticket-1', ticketTypeName: '<VIP>', ticketTypeCode: 'VIP' }],
      true,
      'https://example.test/tickets',
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;VIP&gt;');
    expect(html).toContain('cid:ticket-ticket-1');
    expect(html).not.toContain('qr_token');
    expect(html).not.toContain('signed-secret');
  });

  it('falls back to an account link while listing every ticket', () => {
    const html = template.ticketIssued(
      'Binh',
      'booking-1',
      [
        { ticketId: 'ticket-1', ticketTypeName: 'VIP', ticketTypeCode: 'VIP' },
        { ticketId: 'ticket-2', ticketTypeName: 'Standard', ticketTypeCode: 'STD' },
      ],
      false,
      'https://example.test/tickets',
    );
    expect(html).toContain('https://example.test/tickets');
    expect(html).toContain('ticket-2');
    expect(html).not.toContain('<img src="cid:');
  });
});
