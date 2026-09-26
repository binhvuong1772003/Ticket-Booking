# Scheduled Ticket Sales Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task after the user requests implementation. Steps use checkbox syntax for tracking.

**Goal:** Cho phép organizer tạo loại vé chỉ được booking từ một ngày giờ xác định.

**Architecture:** Event-service sở hữu `TicketType.salesStartAt`; inventory lưu snapshot từ sự kiện tạo vé. Inventory kiểm tra thời điểm trong conditional update giữ vé hiện tại, không cần cron, queue mới hay RPC mới.

**Tech Stack:** NestJS, GraphQL, Prisma/MongoDB, Kafka outbox, Vitest hiện có.

**Spec:** Thiết kế đề xuất trong phần “Phạm vi và quy tắc” bên dưới, dựa trên yêu cầu trong hội thoại. Người dùng chưa chọn lịch theo session hay ticket type; tài liệu giả định theo ticket type, chưa phải quyết định đã được duyệt.

## Phạm vi và quy tắc

- Backend trước; không triển khai giao diện, countdown hay waiting room trong thay đổi này.
- Lịch theo từng loại vé (`TicketType`). Nhiều loại vé có thể dùng cùng timestamp để mở bán đồng loạt.
- `salesStartAt: DateTime?`: thời điểm tuyệt đối; API dùng ISO 8601 có `Z` hoặc offset, lưu UTC.
- Ví dụ 07:00 ngày 01/10/2026 giờ Việt Nam: `2026-10-01T07:00:00+07:00`, tương đương `2026-10-01T00:00:00.000Z`.
- Trước thời điểm này: không tạo hold, booking hoặc checkout. Bằng hoặc sau thời điểm này: cho phép thử giữ vé theo các điều kiện bán hiện có.
- Không có lịch (`null` hoặc dữ liệu cũ thiếu field): giữ hành vi cũ, vẫn yêu cầu session mở bán và loại vé ACTIVE.
- Lịch trong quá khứ hợp lệ, mang nghĩa đã đến giờ mở bán; không tự đặt thêm ràng buộc thời gian đóng bán.
- Phiên bản đầu: lịch được khai báo lúc tạo loại vé và không sửa sau khi tạo. Khi session còn DRAFT, organizer có thể xóa loại vé rồi tạo lại nếu cần đổi lịch; thao tác này đổi ID vé nên giao diện phải cập nhật tham chiếu.
- Không thêm `salesStartAt` vào UpdateTicketTypeInput. Không tự cho phép ghi field lạ từ GraphQL.
- Đây là giới hạn phạm vi được đề xuất, không phải yêu cầu người dùng đã xác nhận. Nếu cần chỉnh lịch trên cùng ID, dùng phần mở rộng cuối tài liệu trước khi triển khai.
- Đến giờ không tự đổi TicketTypeStatus: ACTIVE/INACTIVE và thời điểm mở bán là hai điều kiện độc lập.

## Global Constraints

- Không thêm dependency, scheduler, topic Kafka, hoặc thay đổi proto cho bản đầu.
- Không sửa luồng thu tiền, hoàn tiền, giữ chỗ 10 phút.
- Không chạy db push hay service trên database bên ngoài chỉ để kiểm tra tính năng.
- Không coi đồng hồ máy khách là nguồn quyết định; dùng đồng hồ backend. Các replica cần đồng bộ thời gian.
- “Đúng giờ” là điều kiện eligibility, không phải cam kết mọi request thành công đúng millisecond; vẫn phụ thuộc tồn kho và thời gian xử lý.
- MongoDB missing khác null: điều kiện query phải xử lý cả hai để vé cũ tiếp tục hoạt động.
- Rollout consumer mới trước producer mới; không cho tạo lịch khi còn replica inventory cũ.

## Review Focus

1. Sát ranh giới: trước 1 ms bị chặn, đúng timestamp được giữ vé — Task 3.
2. Lịch không được mất khi serialize Kafka hoặc khi cập nhật tên/trạng thái loại vé — Task 2.
3. Payload mới chứa ngày lỗi phải bị từ chối, không được coi là vé không có lịch — Task 2.
4. MongoDB document cũ thiếu field và document có null đều giữ hành vi cũ — Tasks 3, 4.
5. Event trùng hoặc consumer triển khai lệch phiên bản không được xóa lịch và mở bán sớm — Tasks 2, 4.

## Task 1: Lưu và công bố lịch tại event-service

**Modify:**
- `apps/event-service/prisma/schema.prisma`
- `apps/event-service/src/modules/events/presentation/graphql/inputs/create-ticket-type.input.ts`
- `apps/event-service/src/modules/events/presentation/graphql/models/ticket-type.model.ts`
- `apps/event-service/src/modules/events/application/ticket-type.service.ts`
- `apps/event-service/src/modules/events/infrastructure/ticket-type.repository.ts`

**Tests:** Mở rộng `apps/event-service/src/modules/events/application/ticket-type.service.spec.ts`; thêm `apps/event-service/src/modules/events/infrastructure/ticket-type.repository.spec.ts` cho persistence/outbox.

**Interfaces:** `CreateTicketTypeInput.salesStartAt?: Date | null`; `CreateTicketTypeData.salesStartAt?: Date | null`; output GraphQL `salesStartAt: Date | null`.

- [ ] Viết test tạo vé có lịch truyền đúng Date tới repository; thiếu/null đều hợp lệ; lịch quá khứ hợp lệ; ngày lỗi không được ghi.
- [ ] Viết test repository: ticketType và outbox được ghi trong cùng transaction; payload `salesStartAt` là ISO string hoặc null, không phải Date object trong Prisma Json.
- [ ] Chạy test mới và ghi nhận failure trước khi sửa.
- [ ] Thêm field nullable vào schema và GraphQL input/output; dùng Date scalar và IsDate theo pattern hiện có, truyền qua service/repository.
- [ ] Thêm `salesStartAt: ticketType.salesStartAt?.toISOString() ?? null` vào payload `ticket-type.created`.
- [ ] Regenerate client: `bunx prisma generate --schema apps/event-service/prisma/schema.prisma`.
- [ ] Chạy lại hai file test bằng `bun run test <đường-dẫn-file-1> <đường-dẫn-file-2>`; tất cả PASS.

**Deliverable:** Tạo/query vé có lịch; quyền organizer và điều kiện session DRAFT vẫn giữ nguyên.

## Task 2: Đồng bộ lịch sang inventory

**Modify:**
- `apps/inventory-service/src/prisma/schema.prisma`
- `apps/inventory-service/src/modules/inventory/application/handlers/ticket-type-created.handler.ts`
- `apps/inventory-service/src/modules/inventory/application/inventory.service.ts`
- `apps/inventory-service/src/modules/inventory/infrastructure/inventory.repository.ts`

**Tests:** Thêm `apps/inventory-service/src/modules/inventory/application/handlers/ticket-type-created.handler.spec.ts`; mở rộng inventory.service.spec.ts và inventory.repository.spec.ts hiện có.

**Interfaces:** `TicketTypeCreatedEvent.payload.salesStartAt?: string | null`; `createFromTicketTypeCreated` và `CreateInventoryData` nhận `salesStartAt?: Date | null`; model Inventory có `salesStartAt DateTime?`.

- [ ] Viết test handler chuyển ISO string hợp lệ sang Date đúng instant; offset +07:00 và Z cho cùng kết quả.
- [ ] Viết test event cũ thiếu field được hiểu là null; string lỗi, chuỗi rỗng hoặc kiểu khác bị từ chối trước khi ghi inventory.
- [ ] Viết test inventory.create lưu lịch; duplicate creation không reset lịch/tồn kho; cập nhật status/name không đổi salesStartAt.
- [ ] Chạy test mới xác nhận FAIL.
- [ ] Parse/validate field ở Kafka boundary, không dùng fallback null khi payload có giá trị lỗi. Truyền Date qua service tới repository.create.
- [ ] Giữ đường xử lý duplicate hiện có, không upsert đè snapshot lịch trên row đã tồn tại.
- [ ] Regenerate client: `bun run prisma:generate:inventory`.
- [ ] Chạy các test đã nêu, xác nhận PASS.

**Deliverable:** Inventory có lịch ngay khi tạo row. Nếu chưa nhận sự kiện tạo vé thì không có tồn kho để reserve, do đó không mở sớm.

## Task 3: Chặn reserve trước giờ và trả lỗi rõ ràng

**Modify:**
- `apps/inventory-service/src/modules/inventory/infrastructure/inventory.repository.ts`
- `apps/booking-service/src/modules/booking/application/booking.service.ts`

**Tests:** Mở rộng inventory.repository.spec.ts và booking.service.spec.ts hiện có.

**Interfaces:** Giữ nguyên Reserve RPC. Inventory trả gRPC FAILED_PRECONDITION (9), message `Ticket sales have not started`; booking ánh xạ riêng lỗi này sang GraphQL `extensions.code = TICKET_SALES_NOT_STARTED` bằng GraphQLError đã có trong dependency của app (kiểm tra manifest trước khi dùng). Các lỗi khác giữ nguyên.

- [ ] Viết test với mốc `2026-10-01T00:00:00.000Z`: trước 1 ms bị chặn; bằng và sau mốc được thử reserve.
- [ ] Viết test không tạo hold khi chưa đến giờ, kể cả available > 0; không gọi payment/createPending khi inventory trả lỗi chưa mở bán.
- [ ] Viết test tới giờ nhưng session inactive/type inactive/sold out vẫn không được reserve; vé thiếu field hoặc null vẫn theo luật cũ.
- [ ] Chạy test mới xác nhận FAIL.
- [ ] Lấy `now = new Date()` một lần đầu reserve; thêm OR vào cùng updateMany: `salesStartAt <= now`, `salesStartAt == null`, hoặc `salesStartAt isSet false`.
- [ ] Giữ nguyên điều kiện available >= quantity, sessionActive và typeActive, cùng transaction tạo hold. Không chỉ check Date trước một update không có điều kiện giờ.
- [ ] Khi updateMany.count = 0: đọc row để phân loại lỗi. Ưu tiên không tồn tại/ngừng bán, rồi chưa tới giờ, rồi hết vé. Dùng cùng now cho kiểm tra này.
- [ ] Trong reserveInventory ở booking, ánh xạ gRPC code 9 kèm đúng details/message nêu trên sang GraphQLError; không ánh xạ mọi code 9 thành lỗi lịch. Thêm ponytail comment nếu dùng message làm discriminator, nêu chuyển sang metadata/error reason khi có thêm lỗi nghiệp vụ.
- [ ] Chạy test lại và xác nhận PASS.

**Deliverable:** Gọi trực tiếp API trước giờ cũng bị chặn; frontend không thể vượt điều kiện bằng sửa đồng hồ hoặc bỏ countdown.

## Task 4: Kiểm chứng tích hợp và rollout

**Create:** `apps/inventory-service/test/scheduled-sales.integration.spec.ts` dùng MongoDB replica set test riêng, không dùng DATABASE_URL đang trỏ môi trường thật.

**Modify:** README.md phần mô tả tính năng, timezone, giới hạn lịch cố định và rollout.

- [ ] Viết integration test opt-in qua `SCHEDULED_SALES_TEST_DATABASE_URL`; nếu thiếu thì skip với lý do rõ ràng. Prisma test client phải nhận URL này trực tiếp.
- [ ] Tạo fixture có lịch tương lai, đúng mốc, null và document thực sự thiếu field (raw insert vào DB test); verify reserve thật và số lượng hold/counters sau mỗi request.
- [ ] Test nhiều request tranh vé cuối sau giờ mở bán: tối đa một request lấy được vé cuối, available không âm. Conflict transaction có thể trả lỗi; không coi mock unit test là bằng chứng chống oversell.
- [ ] Test qua GraphQL gateway: tạo loại vé có lịch, query trả UTC, request sớm trả TICKET_SALES_NOT_STARTED và không sinh checkout; sau giờ tạo booking PENDING bình thường. Dùng payment mock/test double để không cần charge thật.
- [ ] Chạy unit suite `bun run test`, lint `bun run lint`, và build lần lượt `bun run build:event`, `bun run build:inventory`, `bun run build:booking`, `bun run build:gateway`. Ghi riêng lỗi baseline nếu có.
- [ ] Rollout: schema/client tương thích → nâng toàn bộ inventory → nâng booking error mapping → nâng event-service/API cho phép nhập lịch. Test trên staging trước khi mở tính năng.
- [ ] Smoke test một lịch tương lai trên staging; xác nhận trước giờ không giữ vé và từ giờ mở bán có thể tạo hold.
- [ ] Ghi rõ rollback: không hạ inventory về bản bỏ qua salesStartAt khi còn vé hẹn giờ đang hoạt động; phải dừng nhận booking trước nếu bắt buộc rollback.

**Deliverable:** Có bằng chứng trên MongoDB thật cho boundary/missing/null/concurrency, và thứ tự triển khai không tạo cửa sổ mở bán sớm.

## Mở rộng nếu cần chỉnh lịch sau khi tạo

Không bật bằng cách chỉ thêm salesStartAt vào ticket-type.updated: created/updated đi qua các topic khác nhau, update có thể tới trước created hoặc event cũ tới sau event mới.

Nếu người dùng cần đổi lịch trên cùng ID, lập bổ sung thiết kế trước khi code: phiên bản tăng đơn điệu của lịch; projection giữ được phiên bản mới nhất kể cả update-before-create; cập nhật lịch và version atomically; cơ chế xác nhận inventory đã áp dụng trước khi báo lịch mới có hiệu lực. Đặc biệt dời giờ về muộn không được trả success trong lúc inventory còn cho đặt theo lịch cũ. Không dùng Inventory.version hiện tại làm phiên bản nguồn vì reserve/release cũng tăng nó.

## Tiêu chí hoàn tất

- Trước giờ không có side effect đặt vé/thanh toán.
- Đúng giờ và sau giờ đủ điều kiện đặt vé theo tồn kho và trạng thái hiện tại.
- Giao diện có thể đọc salesStartAt để thông báo ngày giờ mở bán.
- Vé cũ vẫn hoạt động; không cần backfill để triển khai bản đầu.
- Không có cron hoặc topic mới; không phải chờ Kafka phát event đúng giờ mở bán vì lịch đã được lưu trước.
- Các giới hạn theo ticket type, lịch cố định, backend-only được trình bày rõ để người dùng lựa chọn trước khi triển khai.
