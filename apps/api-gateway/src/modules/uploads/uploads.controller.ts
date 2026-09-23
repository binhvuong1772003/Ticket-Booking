import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  PayloadTooLargeException,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import type { Request } from 'express';

const FOLDERS = {
  avatar: 'avatars',
  event: 'events',
} as const;

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/* multer's hard ceiling sits above the friendly limit so oversize files
   fail fast but the API still answers 413 instead of a generic 500. */
const MULTER_LIMIT_BYTES = 8 * 1024 * 1024;

type SignBody = {
  purpose?: keyof typeof FOLDERS;
};

/* Minimal multer file shape — avoids a @types/multer dependency. */
type UploadedImageFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

type CloudinaryUploadResponse = {
  secure_url?: string;
  public_id?: string;
  width?: number;
  height?: number;
  error?: { message?: string };
};

function cloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new ServiceUnavailableException('Upload is not configured');
  }
  return { cloudName, apiKey, apiSecret };
}

function folderFor(purpose: keyof typeof FOLDERS | undefined) {
  const folder = purpose ? FOLDERS[purpose] : undefined;
  if (!folder) {
    throw new BadRequestException('purpose must be one of: avatar, event');
  }
  return folder;
}

@Controller('uploads')
export class UploadsController {
  /* Signed-upload ticket: browser takes this and uploads straight to
     Cloudinary. Kept for flows that must bypass the gateway body limit. */
  @Post('sign')
  sign(
    @Req() req: Request & { user?: { sub: string } },
    @Body() body: SignBody,
  ) {
    if (!req.user?.sub) {
      throw new UnauthorizedException('Authentication is required');
    }

    const { cloudName, apiKey, apiSecret } = cloudinaryConfig();
    const folder = folderFor(body.purpose);

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHash('sha1')
      .update(`folder=${folder}&timestamp=${timestamp}` + apiSecret)
      .digest('hex');

    return { cloudName, apiKey, timestamp, folder, signature };
  }

  /* Server-side upload: browser sends the file here, the gateway signs and
     forwards to Cloudinary — the API secret never leaves the server and the
     file bytes can be validated before they reach the CDN. */
  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MULTER_LIMIT_BYTES },
    }),
  )
  async uploadImage(
    @Req() req: Request & { user?: { sub: string } },
    @UploadedFile() file: UploadedImageFile | undefined,
    @Body() body: SignBody,
  ) {
    if (!req.user?.sub) {
      throw new UnauthorizedException('Authentication is required');
    }

    const { cloudName, apiKey, apiSecret } = cloudinaryConfig();
    const folder = folderFor(body.purpose);

    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException('file must be JPEG, PNG, WebP or AVIF');
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new PayloadTooLargeException('file exceeds 5MB');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHash('sha1')
      .update(`folder=${folder}&timestamp=${timestamp}` + apiSecret)
      .digest('hex');

    /* Cloudinary accepts a base64 data URI as `file` — avoids multipart
       streaming between gateway and Cloudinary. */
    const form = new FormData();
    form.set(
      'file',
      `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
    );
    form.set('api_key', apiKey);
    form.set('timestamp', String(timestamp));
    form.set('folder', folder);
    form.set('signature', signature);

    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      { method: 'POST', body: form },
    );
    const json = (await res.json()) as CloudinaryUploadResponse;
    if (!res.ok || !json.secure_url || !json.public_id) {
      throw new BadGatewayException(
        json.error?.message ?? 'Cloudinary upload failed',
      );
    }

    return {
      secureUrl: json.secure_url,
      publicId: json.public_id,
      width: json.width,
      height: json.height,
    };
  }
}
