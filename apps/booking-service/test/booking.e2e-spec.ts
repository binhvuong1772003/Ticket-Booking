import type { INestMicroservice } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import type { ClientProxy, MicroserviceOptions } from '@nestjs/microservices';
import type { AddressInfo, Server } from 'node:net';
import { firstValueFrom, timeout } from 'rxjs';
import { AppModule } from '../src/app.module.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('Booking service (TCP e2e)', () => {
  let app: INestMicroservice;
  let client: ClientProxy | undefined;

  beforeAll(async () => {
    app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: 0 },
      logger: false,
    });
    await app.listen();
    const { port } = app.unwrap<Server>().address() as AddressInfo;
    client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port },
    });
  });

  afterAll(async () => {
    client?.close();
    await app?.close();
  });

  it('responds to a health message over TCP', async () => {
    const response = await firstValueFrom(
      client!.send('booking.health', {}).pipe(timeout(3000)),
    );
    expect(response).toEqual({ service: 'booking-service', status: 'ok' });
  });
});
