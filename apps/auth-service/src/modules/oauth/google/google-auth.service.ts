import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { db } from '../../../infrastructure/persistence/prisma.js';
import { ApiError } from '../../../common/errors/api-error.js';
import type { AuthTokens } from '../../auth/application/auth.types.js';
import { TokenService } from '../../auth/application/services/token.service.js';

type GoogleState = {
  nonce: string;
};

@Injectable()
export class GoogleAuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly tokenService: TokenService,
  ) {}

  get frontendSuccessUrl(): string {
    return process.env.FRONTEND_OAUTH_SUCCESS_URL ?? 'http://localhost:5173';
  }

  getAuthorizationUrl(): string {
    const client = this.createClient();
    const nonce = randomUUID();
    const state = this.jwtService.sign({ nonce } satisfies GoogleState, {
      expiresIn: '10m',
    });

    return client.generateAuthUrl({
      access_type: 'online',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
      nonce,
    });
  }

  async authenticate(code: string, state: string): Promise<AuthTokens> {
    if (!code || !state) {
      throw new ApiError('Google authorization is incomplete', {
        code: 'BAD_USER_INPUT',
      });
    }

    const client = this.createClient();
    let statePayload: GoogleState;

    try {
      statePayload = this.jwtService.verify<GoogleState>(state);
    } catch {
      throw new ApiError('Invalid or expired OAuth state', {
        code: 'UNAUTHENTICATED',
      });
    }

    try {
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) {
        throw new Error('Google did not return an ID token');
      }

      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const profile = ticket.getPayload();

      if (
        !profile?.sub ||
        !profile.email ||
        profile.email_verified !== true ||
        profile.nonce !== statePayload.nonce
      ) {
        throw new Error('Google identity could not be verified');
      }

      const verifiedEmail = profile.email;
      const user = await db.$transaction(async (tx) => {
        const account = await tx.oAuthAccount.findUnique({
          where: {
            provider_providerAccountId: {
              provider: 'GOOGLE',
              providerAccountId: profile.sub,
            },
          },
        });

        if (account) {
          return tx.user.findUniqueOrThrow({
            where: { id: account.userId },
          });
        }

        const existingUser = await tx.user.findUnique({
          where: { email: verifiedEmail },
        });
        const user = existingUser
          ? await tx.user.update({
              where: { id: existingUser.id },
              data: {
                emailVerifiedAt: existingUser.emailVerifiedAt ?? new Date(),
                fullName: existingUser.fullName ?? profile.name,
                avatarUrl: existingUser.avatarUrl ?? profile.picture,
              },
            })
          : await tx.user.create({
              data: {
                email: verifiedEmail,
                emailVerifiedAt: new Date(),
                fullName: profile.name,
                avatarUrl: profile.picture,
                role: 'USER',
              },
            });

        await tx.oAuthAccount.create({
          data: {
            provider: 'GOOGLE',
            providerAccountId: profile.sub,
            userId: user.id,
          },
        });

        return user;
      });

      return this.tokenService.issueTokens(user.id);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      throw new ApiError('Google authentication failed', {
        code: 'UNAUTHENTICATED',
      });
    }
  }

  private createClient(): OAuth2Client {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const callbackUrl =
      process.env.GOOGLE_REDIRECT_URI ?? process.env.DOCKER_GOOGLE_REDIRECT_URI;

    if (!clientId || !clientSecret || !callbackUrl) {
      throw new Error(
        'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI are required',
      );
    }

    return new OAuth2Client(clientId, clientSecret, callbackUrl);
  }
}
