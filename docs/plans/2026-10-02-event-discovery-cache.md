# Kế hoạch cache dữ liệu khám phá sự kiện

**Mục tiêu:** Giảm số lần `trendingEvents` gọi booking-service mà vẫn kiểm tra trạng thái public/upcoming của event từ dữ liệu hiện tại. Không dùng Redis làm nguồn sự thật cho vé, tồn kho hoặc thanh toán.

**Phạm vi đầu tiên:** Cache trang `internalTrendingSales` trong event-service. Chưa cache toàn bộ GraphQL response, `featuredEvents`, `eventsPage` hay `publicCategories` khi chưa có số đo chứng minh lợi ích.

## Quyết định thiết kế

- Dùng cache-aside: đọc Redis; cache miss thì gọi booking-service và lưu trang trả về với TTL **20 giây**. Redis lỗi thì gọi booking-service như hiện tại; lỗi booking-service vẫn được trả về, không giả vờ thành công.
- Làm tròn `since` của cửa sổ 7 ngày xuống mốc 20 giây ngay trong `TrendingService`. Nếu giữ `Date.now()` đến mili giây, mỗi request tạo một key khác nhau và cache không có hit.
- Key có namespace/version, ví dụ `event:trending-sales:v1:<bucket>:<first>:<cursor-hash>`. Không đưa token hoặc dữ liệu khách hàng vào key/value. `after` rỗng cũng có key riêng.
- Chỉ cache `BookingTrendingPage` đã qua bước kiểm tra schema/HTTP hiện có. Giá trị chỉ gồm ID, cursor và pageInfo nên JSON không làm sai kiểu `Date` của event.
- Sau khi lấy trang doanh số từ Redis, `TrendingService` vẫn gọi `findPublicUpcomingEventsByIds()` ở mỗi request. Event vừa unpublish/cancel hoặc session đã qua sẽ không được lấy từ bản event cũ trong cache. Thứ hạng/doanh số có thể trễ tối đa 20 giây.
- Không thêm lock phân tán, bộ invalidation theo prefix, framework cache mới hay thay đổi Redis eviction policy ở đợt đầu.

## Các bước triển khai

### 1. Đo trước khi sửa

- [ ] Ghi nhận p50/p95 của `trendingEvents`, số trang `internalTrendingSales` được gọi trên mỗi request và tần suất lặp lại query. Nếu tải thấp hoặc booking call không chiếm thời gian đáng kể, dừng tại đây.

### 2. Cache trang doanh số

- [x] Trong `apps/event-service/src/modules/events/application/trending.service.ts`, làm tròn `since` một lần mỗi request và dùng cùng giá trị cho mọi trang phân trang.
- [x] Trong `apps/event-service/src/modules/events/infrastructure/booking-trending.client.ts`, tách phần fetch/validate hiện có để `getSalesPage()` thực hiện cache-aside. Tạo một kết nối Redis dùng lại, đóng khi module dừng; đặt thời hạn kết nối ngắn và không xếp hàng lệnh khi Redis mất kết nối.
- [x] Khai báo `ioredis` trong `apps/event-service/package.json` (dependency đã có ở root), thêm `REDIS_HOST`/`REDIS_PORT` vào `apps/event-service/.env.example` và môi trường `event-service` trong `compose.yaml`. Redis không được làm event-service khởi động thất bại.
- [x] Đặt TTL cố định 20 giây, key có version; không cache lỗi HTTP, GraphQL, schema hoặc exception. Cache miss/read/write lỗi chỉ làm request đi theo đường cũ.

### 3. Kiểm tra đúng hành vi

- [x] Bổ sung test ở `trending.service.spec.ts`: hai request trong cùng bucket dùng cùng `since`; phân trang vẫn giữ nguyên cursor; `first`/`city` sai vẫn bị từ chối.
- [x] Bổ sung test cho `booking-trending.client.ts`: hit không gọi booking-service; miss gọi một lần; Redis hỏng vẫn lấy dữ liệu; trang lỗi không được cache; key khác nhau theo bucket/cursor; TTL đúng 20 giây.
- [x] Test luồng: cached sales page chứa event vừa bị hủy/unpublish thì kết quả `trendingEvents` vẫn loại event đó nhờ bước đọc event hiện tại.
- [x] Chạy test liên quan, `bun run build:event`, và `docker compose config --quiet`. Không cần migration hay `prisma db push`.

### 4. Rollout và quyết định mở rộng

- [ ] Triển khai với Redis đang có; theo dõi hit rate, p95 `trendingEvents`, lượng request sang booking-service, Redis memory/error. Redis này cũng phục vụ BullMQ: giữ TTL ngắn và theo dõi bộ nhớ, không đổi eviction policy bừa bãi.
- [ ] Chỉ cache `featuredEvents` nếu số đo cho thấy truy vấn này đáng kể. Khi đó dùng TTL khoảng 30 giây, test round-trip các trường `Date`/GraphQL `DateTime`, và xác nhận sản phẩm chấp nhận tối đa 30 giây trễ khi event đổi trạng thái. Nếu cần ẩn ngay, thêm invalidation theo mutation trước khi bật cache.
- [ ] Chỉ cache `publicCategories` nếu nó thành điểm nóng: một key TTL khoảng 5 phút và `DEL` sau create/update/remove. `countries`, `places`, `supportedCurrencies` đã là hằng trong code; không cần Redis.

**Ngoài phạm vi:** Inventory availability, reservation, booking, payment, ticket/check-in và mọi query phụ thuộc quyền người xem. `eventsPage` có nhiều tổ hợp filter và cursor; chỉ xem xét một vài biến thể phổ biến nếu metrics chứng minh lợi ích.

**Tình trạng 2026-10-02:** Phần code và test đã triển khai; full suite 421 passed, 23 skipped, event build/lint/Prettier/Compose config đều thành công. Chưa có số đo p50/p95 hoặc smoke test Redis thật vì Docker daemon trên máy hiện không chạy; các bước baseline và rollout phía trên vẫn để mở.
