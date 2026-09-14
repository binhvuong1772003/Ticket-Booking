# Ticket Booking — NestJS monorepo

## Bun workspaces

`package.json` gốc khai báo `"workspaces": ["apps/*"]`. Mỗi app có một
`package.json` riêng và cả repository dùng chung `bun.lock` ở gốc.
`bunfig.toml` dùng `linker = "hoisted"` để các app đã build trong `dist/apps`
resolve được dependency từ `node_modules` chung. `--cwd` vẫn thêm dependency
vào manifest riêng của app. Mọi thư mục `node_modules` đều được Git bỏ qua.
Các dependency và công cụ dùng chung hiện vẫn được giữ ở gốc để phục vụ
build, test và chạy code trong `dist/apps`. Các app khai báo dependency runtime
của mình; dependency mới dành riêng cho app được thêm bằng `--cwd`.

Chạy tại thư mục `ticket-booking`:

```powershell
bun install
# Cài Apollo cho gateway (GraphQL 16 tương thích Apollo Gateway/Server)
bun add @apollo/gateway @apollo/server @nestjs/graphql @nestjs/apollo @as-integrations/express5 "graphql@^16.11.0" --cwd apps/api-gateway
# Build hoặc chạy gateway qua workspace
bun run --cwd apps/api-gateway build
bun run --cwd apps/api-gateway start:dev
```

Lệnh `bun add` trên cập nhật `apps/api-gateway/package.json` và lockfile chung.
Các lệnh build/chạy tại gốc dùng cấu hình Nest monorepo. `auth-service` là
GraphQL subgraph chạy ở cổng 4001 và yêu cầu `JWT_SECRET`, `DATABASE_URL`.

Nest Observe chỉ được bật khi có đủ `OBSERVE_APP_KEY` và `OBSERVE_APP_SECRET`.
Nếu chưa có credential thật, gateway tự tắt Observe để tránh lỗi telemetry 401.

## Cấu trúc dự án

```text
apps/
  api-gateway/
    src/                 # Gateway GraphQL, main.ts và AppModule
    test/                # GraphQL e2e tests
    tsconfig.app.json
  auth-service/
    src/                 # Auth GraphQL subgraph
    prisma/              # Prisma schema
    tsconfig.app.json
  booking-service/
    src/
      booking/           # Module, controller nhận message, service
      main.ts            # Khởi động TCP microservice
      app.module.ts
    test/                # TCP e2e tests
    tsconfig.app.json
dist/apps/               # Kết quả build riêng của từng ứng dụng
nest-cli.json            # Khai báo các ứng dụng trong monorepo
tsconfig.json            # Cấu hình TypeScript dùng chung
```

Chạy các lệnh dưới đây trong thư mục `ticket-booking` (nơi có file này).

```powershell
bun install
```

Mở ba terminal, cùng ở thư mục `ticket-booking`:

```powershell
# Terminal 1: Auth GraphQL subgraph, cổng 4001
bun run start:auth
```

```powershell
# Terminal 2: GraphQL gateway, cổng 3000
bun run start:gateway
```

```powershell
# Terminal 3: TCP booking service, cổng 3001
bun run start:booking
```

Gateway cung cấp GraphQL tại `POST /graphql` và kết hợp schema từ auth service.
Auth service có query `{ health }`. Booking service nhận message `booking.health`
và trả về `{ service: 'booking-service', status: 'ok' }`. Cổng 3001 dùng TCP
của NestJS, không truy cập trực tiếp bằng trình duyệt.

Đổi cổng hoặc URL bằng biến môi trường PowerShell trước khi chạy:

```powershell
$env:PORT = '3000'                                  # Gateway
$env:AUTH_SERVICE_URL = 'http://localhost:4001/graphql'
$env:AUTH_PORT = '4001'                             # Auth service
$env:JWT_SECRET = 'local-development-secret'
$env:DATABASE_URL = 'postgresql://user:password@localhost:5432/ticket_booking'
$env:BOOKING_HOST = '127.0.0.1'
$env:BOOKING_PORT = '3001'                          # Booking service
```

Nest Observe mặc định tắt trong local development. Chỉ đặt
`OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` và tùy chọn `OBSERVE_SERVICE_ID` khi có
credential hợp lệ. Auth service tự nạp `.env` khi chạy bằng script ở root.

## Build và kiểm tra

```powershell
bun run build             # Build gateway, auth và booking
bun run test              # Unit tests
bun run test:e2e          # GraphQL và TCP tests
bun run lint
```

Sau khi build, chạy mỗi lệnh trong một terminal:

```powershell
bun run start:auth:prod    # node dist/apps/auth-service/main.js
bun run start:prod         # node dist/apps/api-gateway/main.js
bun run start:booking:prod # node dist/apps/booking-service/main.js
```

`bun run build:gateway`, `bun run build:auth` và `bun run build:booking` build
riêng từng ứng dụng. `bun run start` / `bun run start:dev` mặc định chọn gateway.
Mỗi ứng dụng có `outDir` và cache TypeScript riêng để build không xóa hoặc ghi đè
ứng dụng còn lại. `tsconfig.build.json` ở gốc trỏ về cấu hình build của gateway
để tương thích với các công cụ đang dùng đường dẫn này.

Khi có kiểu dữ liệu hoặc message dùng chung, có thể thêm thư viện `libs/contracts`
bằng Nest CLI và cấu hình cách build/import thư viện tương ứng.

---

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ bun install
```

## Compile and run the project

```bash
# development
$ bun run start

# watch mode
$ bun run start:dev

# production mode
$ bun run start:prod
```

## Run tests

```bash
# unit tests
$ bun run test

# e2e tests
$ bun run test:e2e

# test coverage
$ bun run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ bun install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Observability

In production applications, observability is essential for understanding how your system behaves, detecting issues early, and maintaining reliable performance.

[NestJS Observe](https://observe.nestjs.com) automatically instruments your NestJS application, giving you deep visibility into your system with minimal setup:

- **Distributed tracing:** Follow requests across services and understand how they flow through your system.
- **Waterfall analysis:** Visualize request execution and identify slow operations, bottlenecks, and unexpected delays.
- **Performance analysis:** Analyze application performance in real time and quickly pinpoint areas that need optimization.
- **Metrics:** Track key application and infrastructure metrics to understand system health and performance trends.
- **Logging:** Centralize and correlate logs with traces and other telemetry to make debugging easier.
- **Error tracking:** Detect errors quickly and investigate their root causes with the surrounding context.
- **SLA monitoring:** Track service-level objectives and identify when your application is approaching or exceeding defined thresholds.
- **Alarms and alerts:** Set up alerts for critical errors, performance degradation, SLA violations, and other anomalies so your team can react quickly.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Auto-instrument your application with [NestJS Observer](https://observer.nestjs.com). Distributed tracing, metrics, and logging made easy. Error tracking and performance monitoring for your NestJS applications.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
