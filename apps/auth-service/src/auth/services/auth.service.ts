import { Inject, Injectable } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import * as bcrypt from 'bcrypt';
import { db } from '../../db/prisma';
import { ApiError } from '../../common/errors/api-error';
import { TokenService } from './token.service';
import { LoginInput } from '../dto/login.input';
import { RegisterInput } from '../dto/register.input';
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
}
