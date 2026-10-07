import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import QRCode from 'qrcode';
import sharp from 'sharp';

export type RenderableTicket = {
  ticketId: string;
  status: 'ISSUED' | 'CHECKED_IN' | 'VOIDED';
  eventTitle: string;
  posterImageUrl: string | null;
  coverImageUrl: string | null;
  venueName: string | null;
  venueAddress: string | null;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  ticketTypeName: string;
  ticketTypeCode: string;
  unitPrice: string;
  currency: string;
  qrToken: string | null;
};

const W = 1800;
const H = 720;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]!);

const wrap = (value: string, maxChars: number, maxLines: number) => {
  const words = value.trim().split(/\s+/u);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const chars = Array.from(word);
    const parts = chars.length > maxChars
      ? Array.from({ length: Math.ceil(chars.length / maxChars) }, (_, i) => chars.slice(i * maxChars, (i + 1) * maxChars).join(''))
      : [word];
    for (const part of parts) {
      if (line && Array.from(`${line} ${part}`).length > maxChars) {
        lines.push(line);
        line = part;
      } else line = line ? `${line} ${part}` : part;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${Array.from(lines[maxLines - 1]).slice(0, maxChars - 1).join('')}…`;
  }
  return lines;
};

const localDate = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: timezone,
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('day')} THÁNG ${part('month')}, ${part('year')}`;
};

const localTime = (date: Date, timezone: string) => new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone,
}).format(date);

const timeOffset = (date: Date, timezone: string) => new Intl.DateTimeFormat('en', {
  timeZone: timezone, timeZoneName: 'longOffset',
}).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? timezone;

const dateTimeParts = (startsAt: string, endsAt: string | null, timezone: string) => {
  const start = new Date(startsAt);
  const startDate = localDate(start, timezone);
  const dateParts = (value: string) => value.match(/^(\d{2}) THÁNG (\d{2}), (\d{4})$/)?.slice(1) ?? [];
  const startOffset = timeOffset(start, timezone);
  if (!endsAt) return { date: startDate, time: `${localTime(start, timezone)} · ${startOffset}` };

  const end = new Date(endsAt);
  const endDate = localDate(end, timezone);
  const endOffset = timeOffset(end, timezone);
  let dateRange = startDate;
  if (startDate !== endDate) {
    const [startDay, startMonth, startYear] = dateParts(startDate);
    const [endDay, endMonth, endYear] = dateParts(endDate);
    dateRange = startYear === endYear && startMonth === endMonth
      ? `${startDay}–${endDay} THÁNG ${startMonth}, ${startYear}`
      : `${startDay}/${startMonth}/${startYear} – ${endDay}/${endMonth}/${endYear}`;
  }
  if (startDate === endDate && startOffset === endOffset) {
    return { date: startDate, time: `${localTime(start, timezone)}–${localTime(end, timezone)} · ${startOffset}` };
  }
  const time = startOffset === endOffset
    ? `${localTime(start, timezone)}–${localTime(end, timezone)} · ${startOffset}`
    : `${localTime(start, timezone)} · ${startOffset} – ${localTime(end, timezone)} · ${endOffset}`;
  return {
    date: dateRange,
    time,
  };
};

const headlineLines = (value: string, maxChars: number) => {
  const words = value.trim().split(/\s+/u);
  if (words.length >= 3 && words.length <= 6) {
    let best: { first: string; second: string; score: number } | null = null;
    for (let i = 1; i < words.length; i++) {
      const first = words.slice(0, i).join(' ');
      const second = words.slice(i).join(' ');
      const longest = Math.max(Array.from(first).length, Array.from(second).length);
      if (longest <= maxChars) {
        const score = Math.abs(Array.from(first).length - Array.from(second).length);
        if (!best || score < best.score) best = { first, second, score };
      }
    }
    if (best) return [best.first.toLocaleUpperCase('vi-VN'), best.second.toLocaleUpperCase('vi-VN')];
  }
  return wrap(value.toLocaleUpperCase('vi-VN'), maxChars, 2);
};

const publicIPv4 = (ip: string) => {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
    (a === 203 && b === 0 && c === 113)
  );
};

@Injectable()
export class TicketRendererService {
  private activeRenders = 0;
  private readonly renderWaiters: (() => void)[] = [];

  async renderTicketPng(ticket: RenderableTicket): Promise<Buffer> {
    if (this.activeRenders >= 2) {
      await new Promise<void>((resolve) => this.renderWaiters.push(resolve));
    }
    this.activeRenders++;
    try {
      return await this.render(ticket);
    } finally {
      this.activeRenders--;
      this.renderWaiters.shift()?.();
    }
  }

  // ponytail: two in-process renders bound image memory; add a shared queue only if replicas need a global cap.
  private async render(ticket: RenderableTicket): Promise<Buffer> {
    if (!ticket.eventTitle || !ticket.startsAt || !ticket.timezone || !ticket.qrToken && ticket.status !== 'VOIDED') {
      throw new ServiceUnavailableException({ code: 'TICKET_PREPARING' });
    }

    const renderImage = async (url: string, width: number, height: number) => {
      const bytes = await this.fetchCover(url);
      const image = await sharp(bytes, { limitInputPixels: 16_000_000 })
        .rotate()
        .resize(width, height, { fit: 'contain', background: '#F7F5F0' })
        .jpeg({ quality: 88 })
        .toBuffer();
      return `data:image/jpeg;base64,${image.toString('base64')}`;
    };
    let poster: string | null = null;
    if (ticket.posterImageUrl) {
      try {
      poster = await renderImage(ticket.posterImageUrl, 480, 640);
      } catch {
        // An unavailable poster falls back to the event cover.
      }
    }
    let cover: string | null = null;
    if (!poster && ticket.coverImageUrl) {
      try {
        cover = await renderImage(ticket.coverImageUrl, 1160, 260);
      } catch {
        // Images are decorative; the ticket remains usable without them.
      }
    }

    const qr = ticket.qrToken && ticket.status !== 'VOIDED'
      ? `data:image/png;base64,${(await QRCode.toBuffer(ticket.qrToken, {
          type: 'png', width: 320, margin: 4, errorCorrectionLevel: 'M',
        })).toString('base64')}`
      : null;
    const detailsX = poster ? 560 : 112;
    const detailX = detailsX + 52;
    const eventLines = headlineLines(ticket.eventTitle, cover ? 30 : poster ? 18 : 20);
    const ticketTypeName = wrap(ticket.ticketTypeName, poster ? 18 : 28, 1)[0] ?? '';
    const eyebrowY = cover ? 345 : 105;
    const titleY = cover ? 386 : 202;
    const titleLineHeight = cover ? 42 : 76;
    const dateY = titleY + eventLines.length * titleLineHeight + (cover ? 8 : 18);
    const timeY = dateY + 31;
    const venueY = timeY + (cover ? 57 : 68);
    const footerDividerY = cover ? 584 : 535;
    const footerLabelY = footerDividerY + 34;
    const footerValueY = footerLabelY + 41;
    const title = eventLines.map((line, i) => `<text x="${detailsX}" y="${titleY + i * titleLineHeight}" class="headline${cover ? ' cover-headline' : ''}">${escapeXml(line)}</text>`).join('');
    const when = dateTimeParts(ticket.startsAt, ticket.endsAt, ticket.timezone);
    const dateText = when.date;
    const textWidth = 1320 - detailX - 20;
    const dateWidthAttr = Array.from(dateText).length * 17.5 > textWidth
      ? `textLength="${textWidth}" lengthAdjust="spacingAndGlyphs"`
      : '';
    const venueName = wrap(ticket.venueName || ticket.venueAddress || 'Địa điểm sẽ được cập nhật', poster ? 32 : 44, 1)[0] ?? '';
    const venueWidthAttr = Array.from(venueName).length * 19.5 > textWidth
      ? `textLength="${textWidth}" lengthAdjust="spacingAndGlyphs"`
      : '';
    const calendarIcon = `<g transform="translate(${detailsX},${dateY - 26})" fill="none" stroke="#26231F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="30" height="29" rx="4"/><path d="M9 1v7M25 1v7M3 12h28M10 19h2m7 0h2m-11 7h2m7 0h2"/></g>`;
    const pinIcon = `<g transform="translate(${detailsX},${venueY - 30})" fill="none" stroke="#26231F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 34s14-13 14-21a14 14 0 1 0-28 0c0 8 14 21 14 21Z"/><circle cx="18" cy="13" r="4"/></g>`;
    const price = Number(ticket.unitPrice) === 0
      ? 'Miễn phí'
      : new Intl.NumberFormat('vi-VN', { style: 'currency', currency: ticket.currency }).format(Number(ticket.unitPrice));
    const status = ticket.status === 'VOIDED' ? 'ĐÃ HỦY' : ticket.status === 'CHECKED_IN' ? 'ĐÃ SỬ DỤNG' : '';
    const qrMarkup = qr
      ? `<rect x="1387" y="174" width="304" height="304" rx="8" fill="white"/><image x="1395" y="182" width="288" height="288" preserveAspectRatio="xMidYMid meet" href="${qr}"/>`
      : `<rect x="1387" y="174" width="304" height="304" rx="8" fill="#e8e5df"/><text x="1539" y="340" text-anchor="middle" class="small">QR không còn hiệu lực</text>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <style>text{font-family:'Noto Sans','DejaVu Sans',Arial,sans-serif;fill:#26231F}.eyebrow{font-size:22px;font-weight:700;letter-spacing:2px;fill:#D95F2B}.headline{font-size:70px;font-weight:900;letter-spacing:.5px}.cover-headline{font-size:44px}.date{font-size:28px;font-weight:800}.muted{font-size:22px;fill:#756F68}.venue{font-size:30px;font-weight:800}.label{font-size:17px;letter-spacing:1.5px;fill:#685F55}.qr-caption{font-size:20px;font-weight:800;fill:#26231F}.value{font-size:34px;font-weight:800}.code{font-family:monospace;font-size:24px;fill:#D95F2B}</style>
      <rect x="30" y="30" width="1740" height="660" rx="24" fill="#4D4942"/>
      <rect x="34" y="34" width="1732" height="652" rx="20" fill="#F7F5F0"/>
      <rect x="1320" y="38" width="438" height="644" fill="#fffdf9"/>
      <path d="M1320 38V682" stroke="#D95F2B" stroke-width="3" stroke-dasharray="5 12"/>
      ${poster ? `<rect x="40" y="40" width="480" height="640" rx="16" fill="#E8E0D2"/><image x="40" y="40" width="480" height="640" preserveAspectRatio="xMidYMid meet" href="${poster}"/>` : ''}
      ${cover ? `<rect x="88" y="58" width="1208" height="254" rx="12" fill="#E8E0D2"/><image x="112" y="70" width="1160" height="230" preserveAspectRatio="xMidYMid meet" href="${cover}"/>` : ''}
      <text x="${detailsX}" y="${eyebrowY}" class="eyebrow">VÉ THAM DỰ</text>
      ${title}
      ${calendarIcon}
      <text x="${detailX}" y="${dateY}" class="date" ${dateWidthAttr}>${escapeXml(dateText)}</text>
      <text x="${detailX}" y="${timeY}" class="muted">${escapeXml(when.time)}</text>
      ${pinIcon}
      <text x="${detailX}" y="${venueY}" class="venue" ${venueWidthAttr}>${escapeXml(venueName)}</text>
      <path d="M${detailsX} ${footerDividerY}H1300" stroke="#D7D2CB" stroke-width="2"/>
      <path d="M${detailsX + (poster ? 354 : 520)} ${footerDividerY + 17}V676" stroke="#D7D2CB" stroke-width="2"/>
      <text x="${detailsX}" y="${footerLabelY}" class="label">LOẠI VÉ</text>
      <text x="${detailsX}" y="${footerValueY}" class="value">${escapeXml(ticketTypeName)}</text>
      <text x="${detailsX + (poster ? 390 : 560)}" y="${footerLabelY}" class="label">GIÁ VÉ</text>
      <text x="${detailsX + (poster ? 390 : 560)}" y="${footerValueY}" class="value">${escapeXml(price)}</text>
      <text x="1539" y="119" text-anchor="middle" font-size="24" font-weight="700" fill="#D95F2B">${status || 'VÉ ĐIỆN TỬ'}</text>
      ${qrMarkup}
      <text x="1539" y="530" text-anchor="middle" class="qr-caption">Quét mã tại cổng</text>
      <path d="M1407 570H1671" stroke="#D95F2B" stroke-width="3"/>
      <text x="1539" y="606" text-anchor="middle" class="label">MÃ VÉ</text>
      <text x="1539" y="650" text-anchor="middle" class="code">...</text>
    </svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  private async fetchCover(input: string) {
    let url = new URL(input);
    for (let redirects = 0; redirects <= 2; redirects++) {
      if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || url.port || url.username || url.password) {
        throw new Error('Unapproved cover image URL');
      }
      let dnsTimer: NodeJS.Timeout | undefined;
      const addresses = await Promise.race([
        lookup(url.hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          dnsTimer = setTimeout(() => reject(new Error('Cover DNS lookup timed out')), 3000);
        }),
      ]).finally(() => { if (dnsTimer) clearTimeout(dnsTimer); });
      if (!addresses.length || addresses.some(({ address }) => !publicIPv4(address))) {
        throw new Error('Cover host is not public');
      }
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 2) throw new Error('Cover redirect rejected');
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !/^image\/(jpeg|png|webp|avif)$/.test(response.headers.get('content-type') ?? '')) {
        throw new Error('Cover response is not an image');
      }
      const size = Number(response.headers.get('content-length') ?? 0);
      if (size > MAX_IMAGE_BYTES || !response.body) throw new Error('Ticket image is too large');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new Error('Cover is too large');
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      const metadata = await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata();
      if (!metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096) {
        throw new Error('Cover dimensions are not allowed');
      }
      return bytes;
    }
    throw new Error('Cover redirects exceeded');
  }
}
