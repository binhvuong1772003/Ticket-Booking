import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('API gateway (e2e)', () => {
  let app: INestApplication<App>;
  let authApp: INestApplication;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test-jwt-secret';
    process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';

    const { AppModule: AuthAppModule } =
      await import('../../auth-service/src/app.module.js');
    authApp = await NestFactory.create(AuthAppModule, { logger: false });
    await authApp.listen(0);
    process.env.AUTH_SERVICE_URL = `${await authApp.getUrl()}/graphql`;

    const { AppModule } = await import('../src/app.module.js');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('proxies the auth health query through GraphQL', async () => {
    await request(app.getHttpServer())
      .post('/graphql')
      .send({ query: '{ health }' })
      .expect(200)
      .expect({ data: { health: 'auth-service is healthy' } });
  });

  it('returns BAD_USER_INPUT for invalid auth input', async () => {
    const response = await request(app.getHttpServer())
      .post('/graphql')
      .send({
        query:
          'mutation { register(input: { email: "invalid", password: "short" }) { accessToken } }',
      })
      .expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  afterAll(async () => {
    await app?.close();
    await authApp?.close();
  });
});
