import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { UserStatus } from '../../presentation/graphql/inputs/update-user-status.input.js';
import { db } from '../../../../infrastructure/persistence/prisma.js';

vi.mock('../../../../infrastructure/persistence/prisma.js', () => ({
  db: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    session: { updateMany: vi.fn() },
    refreshToken: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('bcrypt', () => ({
  compare: vi.fn(),
  hash: vi.fn(),
}));

const user = db.user as unknown as { findUnique: Mock; update: Mock };
const session = db.session as unknown as { updateMany: Mock };
const refreshToken = db.refreshToken as unknown as { updateMany: Mock };
const transaction = db.$transaction as unknown as Mock;
const compare = bcrypt.compare as unknown as Mock;
const hash = bcrypt.hash as unknown as Mock;

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    vi.clearAllMocks();
    transaction.mockImplementation((arg: unknown) =>
      typeof arg === 'function' ? arg(db) : Promise.resolve(arg),
    );

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: TokenService, useValue: {} },
        { provide: 'KAFKA_CLIENT', useValue: { emit: vi.fn() } },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  describe('changePassword', () => {
    it('rejects when current password does not match', async () => {
      user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: 'old' });
      compare.mockResolvedValue(false);

      await expect(
        service.changePassword('u1', {
          currentPassword: 'wrong-pass',
          newPassword: 'new-password-1',
        }),
      ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
      expect(user.update).not.toHaveBeenCalled();
    });

    it('rejects when account has no password', async () => {
      user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: null });

      await expect(
        service.changePassword('u1', {
          currentPassword: 'any',
          newPassword: 'new-password-1',
        }),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    });

    it('rehashes and revokes all sessions', async () => {
      user.findUnique.mockResolvedValue({ id: 'u1', passwordHash: 'old' });
      compare.mockResolvedValue(true);
      hash.mockResolvedValue('new-hash');

      await service.changePassword('u1', {
        currentPassword: 'old-password-1',
        newPassword: 'new-password-1',
      });

      expect(user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u1' },
          data: { passwordHash: 'new-hash' },
        }),
      );
      expect(session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1', revokedAt: null },
        }),
      );
      expect(refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1', revokedAt: null },
        }),
      );
    });
  });

  describe('updateUserStatus', () => {
    it('revokes sessions when blocking a user', async () => {
      user.update.mockResolvedValue({ id: 'u1', status: 'BLOCKED' });

      await service.updateUserStatus({ userId: 'u1', status: UserStatus.BLOCKED });

      expect(user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u1' },
          data: { status: 'BLOCKED' },
        }),
      );
      expect(session.updateMany).toHaveBeenCalled();
      expect(refreshToken.updateMany).toHaveBeenCalled();
    });

    it('does not revoke sessions when activating', async () => {
      user.update.mockResolvedValue({ id: 'u1', status: 'ACTIVE' });

      await service.updateUserStatus({ userId: 'u1', status: UserStatus.ACTIVE });

      expect(session.updateMany).not.toHaveBeenCalled();
      expect(refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });
});
