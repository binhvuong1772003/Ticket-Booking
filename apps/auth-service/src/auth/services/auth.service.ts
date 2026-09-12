import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { db } from '../../db/prisma';
import { ApiError } from '../../common/errors/api-error';
import { TokenService } from './token.service';
import { LoginInput } from '../dto/login.input';
import { RegisterInput } from '../dto/register.input';
@Injectable()
export class AuthService {
  constructor(private readonly tokenService: TokenService) {}
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
  async revokeSession(sessionId: string) {
    const session = await db.session.findUnique({
      where: { id: sessionId },
    });
    if (!session) {
      throw new ApiError('Session not found', {
        code: 'NOT_FOUND',
        details: { sessionId },
      });
    }
    await db.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
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
    return this.tokenService.issueTokens(user.id);
  }
}
