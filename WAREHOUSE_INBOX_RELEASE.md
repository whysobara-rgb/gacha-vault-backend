# Step 4c — physical stock, reservation, inbox and notices

Implementation complete in source; this is not production launch approval.

## Fulfillment invariants

- Warehouse SKU codes identify a physical product shared by multiple catalog prize rows. A new SKU starts with zero stock; no production stock is seeded by the migration.
- Receive/adjust operations append immutable movements and require an expected version, an active WAREHOUSE permission and an idempotency key. An adjustment cannot reduce on-hand below reserved.
- REQUESTED → PREPARING reserves all shipment items atomically, grouped by SKU. Every item must have a warehouse link and enough available stock. Failure leaves shipment, inventory, GP and notifications unchanged.
- Cancellation releases reserved stock and refunds the existing shipping fee transaction once. COLLECTED consumes both on-hand and reserved quantities once. Later shipping updates do not decrement stock again.
- Reservations retain their SKU identity even if a catalog item is relinked later. A legacy PREPARING shipment without allocations cannot be collected until an operator explicitly reserves stock against its current version.
- Lock order: sorted user IDs → fulfillment → inventory → item links → sorted SKU IDs. Manual stock adjustment uses user → SKU. No network calls occur inside warehouse transactions.
- Physical warehouse counts do not alter the published lottery probabilities. Initial stock and supply planning for already awarded/unshipped prizes still require operational reconciliation before release.

## Inbox and notice behavior

- Shipment updates and support replies insert one private in-app notification in the same database transaction. No customer address, tracking number or support message body is copied into notifications.
- Inbox reads are scoped to the authenticated user. The read watermark must not exceed the latest owned notification; newly arrived messages remain unread after a prior watermark retry.
- ANNOUNCEMENTS is a separate operator permission. DRAFT → PUBLISHED → ARCHIVED uses reviewed, versioned, idempotent changes. Published text is immutable; archive and create a new notice to replace it. Draft and archived content is absent from customer APIs. Read state is per user.
- Push, email, SMS, support attachments, carrier automation and delivery exceptions/returns are not supplied by this step.

## Deployment order

1. Submit the cumulative account + operations + warehouse patch onto the reviewed PR branch, run unit/HTTP and real PostgreSQL suites.
2. Back up and reconcile the test database; apply all twelve migrations using the compiled migration command. Do not use schema synchronization.
3. Deploy the matching backend build and verify `/health/ready` reports the exact build/schema pair.
4. Register real SKU codes, record verified receipts, link old physical item rows and reserve legacy preparation shipments. No public endpoint can grant operator permissions; use the controlled deployment process for named accounts.
5. Exercise intake, stock shortage, preparation, cancellation, collection and alerts with a dedicated account before native/production release.

Mutation flags remain `NODE_ENV=test|development`, `ENABLE_OPERATIONS_PREVIEW=true`, `ENABLE_LEGACY_TRANSACTIONS=false`. Actual production activation, store review, Danal approval/cancellation/reconciliation, native integration and device testing are still separate release gates.

## Verification evidence

- Local build and TypeScript check; 184 tests across 25 suites passed, including eight stock/inbox SQL lifecycle tests and four HTTP boundary tests. Twelve migrations apply in PGlite.
- Three real PostgreSQL race tests added: competing final-unit reservations, reservation versus adjustment, and cancellation versus collection. These require the CI PostgreSQL service; they were not executed in this workspace.
- Existing real PostgreSQL account and operations additions also remain pending remote CI.
