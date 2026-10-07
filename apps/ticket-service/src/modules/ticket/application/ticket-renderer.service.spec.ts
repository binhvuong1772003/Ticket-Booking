import { beforeEach, describe, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TicketRendererService, type RenderableTicket } from './ticket-renderer.service';
import { TicketCredentialService } from './credential.service';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '104.16.0.1', family: 4 }]),
}));

const token = '00000000-0000-4000-8000-000000000001.1.signature';
const fixture: RenderableTicket = {
  ticketId: '00000000-0000-4000-8000-000000000001',
  status: 'ISSUED',
  eventTitle: 'Đêm nhạc mùa hè & <bạn bè>',
  posterImageUrl: null,
  coverImageUrl: null,
  venueName: 'Nhà hát Thành phố',
  venueAddress: 'Quận 1, Thành phố Hồ Chí Minh',
  startsAt: '2026-10-01T12:00:00.000Z',
  endsAt: '2026-10-01T15:00:00.000Z',
  timezone: 'Asia/Ho_Chi_Minh',
  ticketTypeName: 'VIP',
  ticketTypeCode: 'VIP',
  unitPrice: '800000',
  currency: 'VND',
  qrToken: token,
};

describe('TicketRendererService', () => {
  beforeEach(() => vi.unstubAllGlobals());

  const assertQr = async (png: Buffer, expected: string) => {
    const crop = await sharp(png).extract({ left: 1395, top: 182, width: 288, height: 288 }).raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(crop.data), crop.info.width, crop.info.height)?.data).toBe(expected);
  };

  it('renders the approved canvas and a decodable QR, formatting event time in its timezone', async () => {
    const png = await new TicketRendererService().renderTicketPng(fixture);
    const metadata = await sharp(png).metadata();
    expect([metadata.width, metadata.height]).toEqual([1800, 720]);

    await assertQr(png, token);
  });

  it('renders very long Vietnamese titles, free tickets, and an unavailable cover', async () => {
    const longTitle = 'Đêm nhạc ă'.repeat(20);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('cover timeout')));
    const png = await new TicketRendererService().renderTicketPng({
      ...fixture,
      eventTitle: longTitle,
      venueName: 'Địa điểm '.repeat(20),
      unitPrice: '0',
      coverImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/event.png',
    });
    expect((await sharp(png).metadata()).width).toBe(1800);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not request non-approved cover hosts and omits an active QR for void tickets', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const png = await new TicketRendererService().renderTicketPng({
      ...fixture,
      status: 'VOIDED',
      qrToken: token,
      coverImageUrl: 'http://127.0.0.1/private.png',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await sharp(png).metadata()).height).toBe(720);
    const crop = await sharp(png).extract({ left: 1395, top: 182, width: 288, height: 288 }).raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(crop.data), crop.info.width, crop.info.height)).toBeNull();
  });

  it('renders poster, cover fallback, and no-image tickets with an intact credential QR', async () => {
    const posterSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#25262a"/><path d="M0 500 300 100 600 500V800H0" fill="#d95f2b"/><text x="300" y="690" fill="white" font-size="50" text-anchor="middle">SAIGON LIVE</text></svg>');
    const coverSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500"><rect width="1200" height="500" fill="#25262a"/><circle cx="900" cy="250" r="190" fill="#d95f2b"/><text x="600" y="270" fill="white" font-size="88" text-anchor="middle">SAIGON LIVE</text></svg>');
    const posterBytes = await sharp(posterSvg).png().toBuffer();
    const coverBytes = await sharp(coverSvg).png().toBuffer();
    const renderer = new TicketRendererService();
    (renderer as any).fetchCover = vi.fn(async (url: string) => url.includes('poster') ? posterBytes : coverBytes);
    const previews: Array<[string, RenderableTicket]> = [
      ['poster', { ...fixture, posterImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/poster.png' }],
      ['cover', {
        ...fixture,
        eventTitle: 'Đêm nhạc mùa thu tại Sài Gòn cùng những người bạn thân thiết',
        venueName: 'Trung tâm biểu diễn nghệ thuật thành phố, Nhà hát lớn',
        ticketTypeName: 'Vé khu vực đứng sát sân khấu đặc biệt',
        coverImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/cover.png',
      }],
      ['no-image', fixture],
    ];
    let signedToken = token;
    if (process.env.WRITE_TICKET_PREVIEW === '1') {
      const priorSecret = process.env.TICKET_SECRET;
      process.env.TICKET_SECRET = 'fixture-only-preview-secret';
      try {
        signedToken = new TicketCredentialService().sign(fixture.ticketId, 1);
      } finally {
        if (priorSecret === undefined) delete process.env.TICKET_SECRET;
        else process.env.TICKET_SECRET = priorSecret;
      }
    }
    const previewDir = join(process.cwd(), 'output', 'ticket-previews');
    if (process.env.WRITE_TICKET_PREVIEW === '1') await mkdir(previewDir, { recursive: true });

    for (const [name, ticket] of previews) {
      const png = await renderer.renderTicketPng({ ...ticket, qrToken: signedToken });
      expect((await sharp(png).metadata()).width).toBe(1800);
      await assertQr(png, signedToken);
      if (process.env.WRITE_TICKET_PREVIEW === '1') {
        await writeFile(join(previewDir, `${name}.png`), png);
      }
    }
    expect((renderer as any).fetchCover).toHaveBeenCalledTimes(2);

    if (process.env.WRITE_TICKET_PREVIEW === '1') {
      const photo = await readFile(join(process.cwd(), 'output', 'event-posters', 'da-nang-city-run.png'));
      (renderer as any).fetchCover = vi.fn().mockResolvedValue(photo);
      const png = await renderer.renderTicketPng({
        ...fixture,
        eventTitle: 'Đà Nẵng City Run — Sự kiện Demo',
        posterImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/poster-photo.png',
        qrToken: signedToken,
      });
      await assertQr(png, signedToken);
      await writeFile(join(previewDir, 'poster-photo.png'), png);

      const referenceTicket: RenderableTicket = {
        ...fixture,
        eventTitle: 'Chạy Bộ Bình Minh',
        posterImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/reference-event.png',
        startsAt: '2026-10-02T23:00:00.000Z',
        endsAt: '2026-10-03T02:00:00.000Z',
        venueName: 'Công Viên QA',
        venueAddress: 'Thành phố Hồ Chí Minh',
        ticketTypeName: 'Runner',
        unitPrice: '100000',
        currency: 'VND',
        qrToken: signedToken,
      };
      const referencePng = await renderer.renderTicketPng(referenceTicket);
      await assertQr(referencePng, signedToken);
      await writeFile(join(previewDir, 'reference-event.png'), referencePng);

      const longValuesPng = await renderer.renderTicketPng({
        ...referenceTicket,
        eventTitle: 'Chạy Bộ Bình Minh',
        startsAt: '2026-10-30T23:00:00.000Z',
        endsAt: '2026-11-02T02:00:00.000Z',
        venueName: 'Công viên trung tâm thành phố ven sông rộng lớn',
        ticketTypeName: 'Runner ưu tiên chuyên nghiệp tham gia cự ly dài',
      });
      await assertQr(longValuesPng, signedToken);
      await writeFile(join(previewDir, 'long-values.png'), longValuesPng);

      (renderer as any).fetchCover = vi.fn().mockResolvedValue(coverBytes);
      const longTitlePng = await renderer.renderTicketPng({
        ...fixture,
        eventTitle: 'Đêm nhạc mùa thu tại Sài Gòn cùng những người bạn thân thiết và khách mời đặc biệt',
        venueName: 'Trung tâm biểu diễn nghệ thuật thành phố, Nhà hát lớn và quảng trường ngoài trời',
        coverImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/long-title-cover.png',
        qrToken: signedToken,
      });
      await assertQr(longTitlePng, signedToken);
      await writeFile(join(previewDir, 'long-title-stress.png'), longTitlePng);
    }
  });
});
