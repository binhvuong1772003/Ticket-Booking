import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { AdminGuard } from './admin.guard';

function graphqlContext() {
  const gqlContext = {
    req: { headers: { authorization: 'Bearer signed' } },
  };
  return {
    getType: () => 'graphql',
    getArgs: () => [null, null, gqlContext, null],
    getClass: () => Object,
    getHandler: () => graphqlContext,
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  it('allows an admin claim from the verified JWT', () => {
    const verify = vi.fn().mockReturnValue({ sub: 'admin-1', role: 'ADMIN' });
    const guard = new AdminGuard({ verify } as unknown as JwtService);

    expect(guard.canActivate(graphqlContext())).toBe(true);
    expect(verify).toHaveBeenCalledWith('signed');
  });

  it('denies organizers, including event owners', () => {
    const verify = vi
      .fn()
      .mockReturnValue({ sub: 'event-owner', role: 'ORGANIZER' });
    const guard = new AdminGuard({ verify } as unknown as JwtService);

    expect(() => guard.canActivate(graphqlContext())).toThrow(ForbiddenException);
  });
});
