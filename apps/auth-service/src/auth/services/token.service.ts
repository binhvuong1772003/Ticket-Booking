import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../db/prisma';
import { ApiError } from '../../common/errors/api-error';
import type { UserRole, AuthTokens, TokenMeta } from '../auth.types';
const REFRESH_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000;
@Injectable()
export class TokenService {
  constructor(private readonly jwtService: JwtService) {}
  async issueTokens(userId: string, meta?: TokenMeta): Promise<AuthTokens> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) {
      throw new ApiError('User not found', {
        code: 'UNAUTHENTICATED',
        details: { userId },
      });
    }
    const accessToken = this.jwtService.sign({
      sub: user.id,
      role: user.role as UserRole,
    });
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshTokenHash = createHash('sha256')
      .update(refreshToken)
      .digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);
    await db.$transaction(async (tx) => {
      const session = await tx.session.create({
        data: {
          userId: user.id,
          ipAddress: meta?.ipAddress,
          userAgent: meta?.deviceInfo,
          expiresAt,
        },
      });
      await tx.refreshToken.create({
        data: {
          tokenHash: refreshTokenHash,
          userId: user.id,
          expiresAt,
          sessionId: session.id,
        },
      });
    });
    return { accessToken, refreshToken };
  }
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

    await db.refreshToken.updateMany({
      where: {
        tokenHash,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }
  async revokeSession(refreshToken: string): Promise<void> {
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

    const token = await db.refreshToken.findUnique({
      where: {
        tokenHash,
      },
      select: {
        sessionId: true,
      },
    });

    if (!token?.sessionId) {
      return;
    }

    const now = new Date();

    await db.$transaction([
      db.session.updateMany({
        where: {
          id: token.sessionId,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
        },
      }),

      db.refreshToken.updateMany({
        where: {
          sessionId: token.sessionId,
          revokedAt: null,
        },
        data: {
          revokedAt: now,
        },
      }),
    ]);
  }
}
