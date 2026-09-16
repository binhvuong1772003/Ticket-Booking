import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GoogleAuthService } from './google-auth.service.js';

@Controller()
export class GoogleAuthController {
  constructor(private readonly googleAuthService: GoogleAuthService) {}

  @Get('oauth/google')
  start(@Res() response: Response) {
    return response.redirect(this.googleAuthService.getAuthorizationUrl());
  }

  @Get('auth/callback/google')
  async callback(@Query('code') code: string, @Query('state') state: string) {
    return this.googleAuthService.authenticate(code, state);
  }
}
