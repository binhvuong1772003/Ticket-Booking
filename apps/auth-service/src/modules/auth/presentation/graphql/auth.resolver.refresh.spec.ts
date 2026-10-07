import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../common/errors/api-error';
import { AuthResolver } from './auth.resolver';

describe('AuthResolver refreshAccessToken', () => {
  const context = () => ({
    req: { headers: { cookie: 'refresh_token=expired-token' } },
    res: { clearCookie: vi.fn(), cookie: vi.fn() },
  }) as any;

  it('clears an invalid refresh cookie so the next page load does not retry it', async () => {
    const service = { refreshAccessToken: vi.fn().mockRejectedValue(new ApiError('Invalid or expired refresh token', { code: 'UNAUTHENTICATED' })) };
    const resolver = new AuthResolver(service as any);
    const request = context();

    await expect(resolver.refreshAccessToken(request)).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    expect(request.res.clearCookie).toHaveBeenCalledWith('refresh_token', expect.objectContaining({ httpOnly: true, path: '/' }));
  });

  it('keeps the cookie when refresh fails for a transient service error', async () => {
    const service = { refreshAccessToken: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const resolver = new AuthResolver(service as any);
    const request = context();

    await expect(resolver.refreshAccessToken(request)).rejects.toThrow('database unavailable');
    expect(request.res.clearCookie).not.toHaveBeenCalled();
  });
});
