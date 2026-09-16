import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

@Controller()
export class GoogleOAuthController {
  private readonly authServiceBaseUrl = (
    process.env.AUTH_SERVICE_BASE_URL ?? 'http://localhost:4001'
  ).replace(/\/$/, '');
  private readonly frontendSuccessUrl =
    process.env.FRONTEND_OAUTH_SUCCESS_URL ?? 'http://localhost:5173';

  @Get('oauth/google')
  async start(@Res() response: Response) {
    try {
      const upstreamResponse = await fetch(
        `${this.authServiceBaseUrl}/oauth/google`,
        { redirect: 'manual' },
      );
      const location = upstreamResponse.headers.get('location');

      if (!location) {
        return response
          .status(502)
          .json({ message: 'Auth service did not return a Google redirect' });
      }

      return response.redirect(location);
    } catch {
      return response
        .status(502)
        .json({ message: 'Auth service is unavailable' });
    }
  }

  @Get('auth/callback/google')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() response: Response,
  ) {
    if (!code || !state) {
      return response
        .status(400)
        .json({ message: 'Google authorization code and state are required' });
    }

    const callbackUrl = new URL(
      `${this.authServiceBaseUrl}/auth/callback/google`,
    );
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    try {
      const upstreamResponse = await fetch(callbackUrl);
      const body = await upstreamResponse.text();

      if (!upstreamResponse.ok) {
        return response
          .status(502)
          .json({ message: 'Google authentication failed' });
      }

      const tokens = JSON.parse(body) as AuthTokens;
      const secure = process.env.NODE_ENV === 'production';

      response.cookie('access_token', tokens.accessToken, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        maxAge: 15 * 60 * 1000,
        path: '/',
      });
      response.cookie('refresh_token', tokens.refreshToken, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: '/',
      });

      return response.redirect(this.frontendSuccessUrl);
    } catch {
      return response
        .status(502)
        .json({ message: 'Auth service is unavailable' });
    }
  }
}
