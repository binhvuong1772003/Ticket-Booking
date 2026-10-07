import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { Request } from 'express';
import { UploadsController } from './uploads.controller';

describe('poster uploads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('rejects incorrect dimensions and corrupt files before uploading', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new UploadsController();
    const req = { user: { sub: 'user' } } as Request & {
      user: { sub: string };
    };
    for (const buffer of [
      Buffer.from('not an image'),
      await sharp({
        create: { width: 400, height: 300, channels: 3, background: 'red' },
      })
        .png()
        .toBuffer(),
    ]) {
      await expect(
        controller.uploadImage(
          req,
          { buffer, mimetype: 'image/png', originalname: 'poster.png' },
          'event-poster',
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a 3:4 poster and uploads it to the poster folder', async () => {
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'test');
    vi.stubEnv('CLOUDINARY_API_KEY', 'key');
    vi.stubEnv('CLOUDINARY_API_SECRET', 'secret');
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          secure_url: 'https://res.cloudinary.com/test/poster.png',
          public_id: 'poster',
          width: 300,
          height: 400,
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const buffer = await sharp({
      create: { width: 300, height: 400, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const result = await new UploadsController().uploadImage(
      { user: { sub: 'user' } } as Request & { user: { sub: string } },
      { buffer, mimetype: 'image/png', originalname: 'poster.png' },
      'event-poster',
    );
    expect(result).toMatchObject({ width: 300, height: 400 });
    expect(fetchMock.mock.calls[0][1].body.get('folder')).toBe(
      'events/posters',
    );
  });
});
