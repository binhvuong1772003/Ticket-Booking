import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
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

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);

const FOLDERS = {
  avatar: 'avatars',
  event: 'events',
} as const;

type UploadedImage = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
};

type CloudinaryUploadResponse = {
  secure_url?: string;
  public_id?: string;
  width?: number;
  height?: number;
  error?: { message?: string };
};

@Controller('uploads')
export class UploadsController {
  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }),
  )
  async uploadImage(
    @Req() req: Request & { user?: { sub: string } },
    @UploadedFile() file: UploadedImage | undefined,
    @Body('purpose') purpose?: keyof typeof FOLDERS,
  ) {
    if (!req.user?.sub) {
      throw new UnauthorizedException('Authentication is required');
    }
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException('Unsupported image type');
    }

    const folder = purpose ? FOLDERS[purpose] : undefined;
    if (!folder) {
      throw new BadRequestException('purpose must be one of: avatar, event');
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException('Upload is not configured');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHash('sha1')
      .update(`folder=${folder}&timestamp=${timestamp}` + apiSecret)
      .digest('hex');

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      file.originalname,
    );
    form.append('api_key', apiKey);
    form.append('timestamp', String(timestamp));
    form.append('folder', folder);
    form.append('signature', signature);

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      { method: 'POST', body: form },
    );
    const result = (await response.json()) as CloudinaryUploadResponse;
    if (!response.ok || !result.secure_url || !result.public_id) {
      throw new BadGatewayException(
        result.error?.message ?? 'Cloudinary upload failed',
      );
    }

    return {
      secureUrl: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
    };
  }
}
