import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { Request, Response } from 'express';
import { ApiError } from '../../../../common/errors/api-error.js';
import { AuthService } from '../../application/services/auth.service.js';
import { AuthTokensPayload } from './models/auth-tokens.payload.js';
import { UserProfile } from './models/user-profile.model.js';
import { LoginInput } from './inputs/login.input.js';
import { RegisterInput } from './inputs/register.input.js';
import { UpdateUserRoleInput } from './inputs/update-user-role.input.js';
import { ChangePasswordInput } from './inputs/change-password.input.js';
import { UpdateProfileInput } from './inputs/update-profile.input.js';
import { UpdateUserStatusInput } from './inputs/update-user-status.input.js';
import { AdminGuard } from './guards/admin.guard.js';
import { AuthUser, JwtAuthGuard } from './guards/jwt-auth.guard.js';

const REFRESH_TOKEN_COOKIE = 'refresh_token';
const REFRESH_TOKEN_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

type GraphQLContext = {
  req: Request & { user?: AuthUser };
  res: Response;
};

function getRefreshToken(request: Request): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return undefined;
  }

  const cookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REFRESH_TOKEN_COOKIE}=`));

  return cookie
    ? decodeURIComponent(cookie.slice(REFRESH_TOKEN_COOKIE.length + 1))
    : undefined;
}

function setRefreshTokenCookie(response: Response, refreshToken: string) {
  const secure = process.env.NODE_ENV === 'production';

  response.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    maxAge: REFRESH_TOKEN_MAX_AGE,
    path: '/',
  });
}

function clearRefreshTokenCookie(response: Response) {
  const secure = process.env.NODE_ENV === 'production';

  response.clearCookie(REFRESH_TOKEN_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/',
  });
}

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Query(() => String)
  health(): string {
    return 'auth-service is healthy';
  }

  @UseGuards(JwtAuthGuard)
  @Query(() => UserProfile)
  async me(@Context() context: GraphQLContext) {
    return this.authService.me(context.req.user!.sub);
  }

  @Mutation(() => AuthTokensPayload)
  async register(
    @Args('input', { type: () => RegisterInput }) input: RegisterInput,
    @Context() context: GraphQLContext,
  ) {
    const tokens = await this.authService.register(input);
    setRefreshTokenCookie(context.res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Mutation(() => AuthTokensPayload)
  async login(
    @Args('input', { type: () => LoginInput }) input: LoginInput,
    @Context() context: GraphQLContext,
  ) {
    const tokens = await this.authService.login(input);
    setRefreshTokenCookie(context.res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Mutation(() => AuthTokensPayload)
  async refreshAccessToken(@Context() context: GraphQLContext) {
    const refreshToken = getRefreshToken(context.req);

    if (!refreshToken) {
      throw new ApiError('Refresh token is required', {
        code: 'UNAUTHENTICATED',
      });
    }

    const tokens = await this.authService.refreshAccessToken(refreshToken);
    setRefreshTokenCookie(context.res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Mutation(() => Boolean)
  async logout(@Context() context: GraphQLContext) {
    const refreshToken = getRefreshToken(context.req);

    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }

    clearRefreshTokenCookie(context.res);
    return true;
  }

  @UseGuards(AdminGuard)
  @Mutation(() => Boolean)
  async updateUserRole(
    @Args('input', { type: () => UpdateUserRoleInput })
    input: UpdateUserRoleInput,
  ) {
    await this.authService.updateUserRole(input);
    return true;
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => Boolean)
  async changePassword(
    @Args('input', { type: () => ChangePasswordInput })
    input: ChangePasswordInput,
    @Context() context: GraphQLContext,
  ) {
    await this.authService.changePassword(context.req.user!.sub, input);
    return true;
  }

  @UseGuards(JwtAuthGuard)
  @Mutation(() => Boolean)
  async updateProfile(
    @Args('input', { type: () => UpdateProfileInput })
    input: UpdateProfileInput,
    @Context() context: GraphQLContext,
  ) {
    await this.authService.updateProfile(context.req.user!.sub, input);
    return true;
  }

  @UseGuards(AdminGuard)
  @Mutation(() => Boolean)
  async updateUserStatus(
    @Args('input', { type: () => UpdateUserStatusInput })
    input: UpdateUserStatusInput,
  ) {
    await this.authService.updateUserStatus(input);
    return true;
  }

  @Mutation(() => Boolean)
  async verifyEmail(@Args('token', { type: () => String }) token: string) {
    await this.authService.verifyEmail(token);
    return true;
  }

  @Mutation(() => Boolean)
  async resendVerificationEmail(
    @Args('email', { type: () => String }) email: string,
  ) {
    await this.authService.resendVerificationEmail(email);
    return true;
  }
}
