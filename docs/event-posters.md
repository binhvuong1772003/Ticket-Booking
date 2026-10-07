# Event posters

Upload a cropped portrait image using `POST /uploads/image` (authenticated multipart request):

- `file`: JPEG, PNG, WebP or AVIF, up to 5 MB.
- `purpose`: `event-poster`.

The upload endpoint checks image dimensions, including EXIF orientation, and rejects images whose displayed width:height is not exactly 3:4 with HTTP 400. Example dimensions: 600x800 or 900x1200. The frontend must crop before uploading.

Pass the returned `secureUrl` as `posterImageUrl` in `createEvent` or `updateEvent`. Request `posterImageUrl` in event query/mutation selections to read it. Existing cover images remain separate.

Draft events may be created without a poster. Publishing requires a nonempty `posterImageUrl`. On update, omit the field to keep the existing poster or provide a new URL to replace it. Passing `null` to remove a poster is allowed only while the event is a draft. Mutation inputs validate the Cloudinary URL; image dimensions are checked at upload, not by fetching URLs during mutations. Clients should use the poster upload purpose.

The internal `ticketSnapshot` query includes `posterImageUrl` for ticket issuance and reschedule snapshots. Older tickets without a stored poster continue to use their stored cover image or the text-only ticket layout.

The MongoDB Event schema adds an optional string. Existing documents require no backfill. Regenerate Prisma Client when deploying; no SQL migration is required.
