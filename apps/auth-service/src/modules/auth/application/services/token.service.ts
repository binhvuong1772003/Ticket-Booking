import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../../../infrastructure/persistence/prisma.js';
import { ApiError } from '../../../../common/errors/api-error.js';
import type { UserRole, AuthTokens, TokenMeta } from '../auth.types.js';

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

  async refreshAccessToken(refreshToken: string): Promise<AuthTokens> {
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const now = new Date();
    const storedToken = await db.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (
      !storedToken ||
      storedToken.revokedAt ||
      storedToken.expiresAt <= now ||
      !storedToken.sessionId
    ) {
      throw new ApiError('Invalid or expired refresh token', {
        code: 'UNAUTHENTICATED',
      });
    }

    const session = await db.session.findUnique({
      where: { id: storedToken.sessionId },
      select: { id: true, revokedAt: true, expiresAt: true },
    });

    if (!session || session.revokedAt || session.expiresAt <= now) {
      throw new ApiError('Invalid or expired refresh session', {
        code: 'UNAUTHENTICATED',
      });
    }

    const user = await db.user.findUnique({
      where: { id: storedToken.userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new ApiError('User not found', {
        code: 'UNAUTHENTICATED',
      });
    }

    const nextRefreshToken = randomBytes(48).toString('base64url');
    const nextRefreshTokenHash = createHash('sha256')
      .update(nextRefreshToken)
      .digest('hex');
    const nextExpiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS);

    await db.$transaction(async (tx) => {
      const revoked = await tx.refreshToken.updateMany({
        where: {
          id: storedToken.id,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });

      if (revoked.count !== 1) {
        throw new ApiError('Refresh token has already been used', {
          code: 'UNAUTHENTICATED',
        });
      }

      await tx.refreshToken.create({
        data: {
          tokenHash: nextRefreshTokenHash,
          userId: user.id,
          sessionId: session.id,
          expiresAt: nextExpiresAt,
        },
      });
    });

    const accessToken = this.jwtService.sign({
      sub: user.id,
      role: user.role as UserRole,
    });

    return { accessToken, refreshToken: nextRefreshToken };
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
  async emailVerificationToken(email: string): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    const verificationTokenHash = createHash('sha256')
      .update(rawToken)
      .digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await db.$transaction(async (tx) => {
      await tx.verificationToken.deleteMany({
        where: {
          email,
          usedAt: null,
        },
      });
      await tx.verificationToken.create({
        data: {
          email,
          tokenHash: verificationTokenHash,
          expiresAt,
        },
      });
    });

    return rawToken;
  }
}
