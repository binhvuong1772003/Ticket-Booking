import { Inject, Injectable } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import type { UserRole } from '../../../../generated/auth-prisma/index.js';
import { db } from '../../../../infrastructure/persistence/prisma.js';
import { ApiError } from '../../../../common/errors/api-error.js';
import { TokenService } from './token.service.js';
import { LoginInput } from '../../presentation/graphql/inputs/login.input.js';
import { RegisterInput } from '../../presentation/graphql/inputs/register.input.js';
import { UpdateUserRoleInput } from '../../presentation/graphql/inputs/update-user-role.input.js';
import { ChangePasswordInput } from '../../presentation/graphql/inputs/change-password.input.js';
import { UpdateProfileInput } from '../../presentation/graphql/inputs/update-profile.input.js';
import { UpdateUserStatusInput } from '../../presentation/graphql/inputs/update-user-status.input.js';
import { createHash, randomUUID } from 'node:crypto';

@Injectable()
export class AuthService {
  constructor(
    private readonly tokenService: TokenService,
    @Inject('KAFKA_CLIENT')
    private readonly kafkaClient: ClientKafka,
  ) {}

  private async publishVerificationEmail(
    userId: string,
    email: string,
    createdAt: Date,
    verificationToken: string,
  ) {
    await firstValueFrom(
      this.kafkaClient.emit('auth.user.registered', {
        eventId: randomUUID(),
        eventType: 'auth.user.registered',
        occurredAt: new Date().toISOString(),
        payload: {
          userId,
          email,
          createdAt: createdAt.toISOString(),
          verificationToken,
        },
      }),
    );
  }

  async login(input: LoginInput) {
    const user = await db.user.findUnique({
      where: {
        email: input.email,
      },
    });
    if (!user || !user.passwordHash) {
      throw new ApiError('Invalid credentials', { code: 'UNAUTHENTICATED' });
    }
    const isPasswordValid = await bcrypt.compare(
      input.password,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new ApiError('Invalid credentials', { code: 'UNAUTHENTICATED' });
    }
    return this.tokenService.issueTokens(user.id);
  }
  async refreshAccessToken(refreshToken: string) {
    return this.tokenService.refreshAccessToken(refreshToken);
  }

  async logout(refreshToken: string) {
    await this.tokenService.revokeSession(refreshToken);
  }
  async register(input: RegisterInput) {
    const { email, password } = input;
    const existingUser = await db.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new ApiError('Email already in use', {
        code: 'CONFLICT',
        details: { email },
      });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.user.create({
      data: {
        email,
        passwordHash,
        role: 'USER',
      },
    });
    const verificationToken =
      await this.tokenService.emailVerificationToken(email);
    await this.publishVerificationEmail(
      user.id,
      user.email,
      user.createdAt,
      verificationToken,
    );
    return this.tokenService.issueTokens(user.id);
  }
  async verifyEmail(token: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const now = new Date();
    const verificationToken = await db.verificationToken.findUnique({
      where: { tokenHash },
    });

    if (
      !verificationToken ||
      verificationToken.usedAt ||
      verificationToken.expiresAt <= now
    ) {
      throw new ApiError('Invalid or expired verification token', {
        code: 'UNAUTHENTICATED',
      });
    }

    await db.$transaction(async (tx) => {
      const consumed = await tx.verificationToken.updateMany({
        where: {
          id: verificationToken.id,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });

      if (consumed.count !== 1) {
        throw new ApiError('Invalid or expired verification token', {
          code: 'UNAUTHENTICATED',
        });
      }

      await tx.user.update({
        where: { email: verificationToken.email },
        data: { emailVerifiedAt: now },
      });
    });
  }
  async resendVerificationEmail(email: string) {
    const user = await db.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new ApiError('User not found', { code: 'NOT_FOUND' });
    }

    if (user.emailVerifiedAt) {
      return;
    }

    const verificationToken =
      await this.tokenService.emailVerificationToken(email);
    await this.publishVerificationEmail(
      user.id,
      user.email,
      user.createdAt,
      verificationToken,
    );
  }

  async updateUserRole(input: UpdateUserRoleInput) {
    if ((input.role as string) === 'ADMIN') {
      throw new ApiError('ADMIN role cannot be assigned here', {
        code: 'FORBIDDEN',
      });
    }

    try {
      return await db.user.update({
        where: { id: input.userId },
        data: {
          role: input.role as UserRole,
        },
        select: { id: true, role: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new ApiError('User not found', { code: 'NOT_FOUND' });
      }

      throw error;
    }
  }

  async changePassword(userId: string, input: ChangePasswordInput) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });

    if (!user) {
      throw new ApiError('User not found', { code: 'NOT_FOUND' });
    }

    if (!user.passwordHash) {
      throw new ApiError('Account has no password', {
        code: 'BAD_USER_INPUT',
      });
    }

    const isPasswordValid = await bcrypt.compare(
      input.currentPassword,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new ApiError('Current password is incorrect', {
        code: 'UNAUTHENTICATED',
      });
    }

    const passwordHash = await bcrypt.hash(input.newPassword, 12);
    const now = new Date();

    await db.$transaction([
      db.user.update({
        where: { id: userId },
        data: { passwordHash },
      }),
      db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),
      db.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
  }

  async updateProfile(userId: string, input: UpdateProfileInput) {
    try {
      return await db.user.update({
        where: { id: userId },
        data: {
          ...(input.fullName !== undefined && { fullName: input.fullName }),
          ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
        },
        select: { id: true, fullName: true, avatarUrl: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new ApiError('User not found', { code: 'NOT_FOUND' });
      }

      throw error;
    }
  }

  async updateUserStatus(input: UpdateUserStatusInput) {
    const now = new Date();

    try {
      return await db.$transaction(async (tx) => {
        const user = await tx.user.update({
          where: { id: input.userId },
          data: { status: input.status },
          select: { id: true, status: true },
        });

        // JWT không chứa status — phải revoke session khi block
        if (input.status === 'BLOCKED') {
          await tx.session.updateMany({
            where: { userId: user.id, revokedAt: null },
            data: { revokedAt: now },
          });
          await tx.refreshToken.updateMany({
            where: { userId: user.id, revokedAt: null },
            data: { revokedAt: now },
          });
        }

        return user;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new ApiError('User not found', { code: 'NOT_FOUND' });
      }

      throw error;
    }
  }
}
