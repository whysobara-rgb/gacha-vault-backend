# Catalog and fulfillment operations · release step 4B

## Implemented

- Separate CATALOG / FULFILLMENT permissions, read from active database grants on each request. Customer-support membership does not imply either permission. No role-grant HTTP endpoint exists.
- Catalog drafts with 1–100 prize definitions, absolute probability in integer parts per million, GP price, box sales capacity, sale type, images and fulfillment eligibility.
- Draft save → explicit publish → sale start/pause. Publishing requires an exact 1,000,000 PPM total and positive per-item probabilities. Unsaved or stale configurations cannot be published.
- Every operation binds an actor-scoped UUID request key to the canonical request body. Repeated requests return the original receipt. Each accepted change has an audit event.
- Publication locks the box used by purchase/reservation transactions. Sales capacity cannot be reduced below net capsule sales, legacy draws and unresolved/live payment reservations.
- New prize rows are created at publication. Previous purchased probability snapshots, original prize rows and acquired inventory are retained. Conversion GP is 10% of normal reference value (floored), 100% for premium prizes.
- Existing card-enabled boxes can be viewed/paused, but configuration publication is blocked. Card price/enable management belongs to the later payment-operations slice.
- Outbound desk lists fulfillment requests without recipient details; the permission-checked detail endpoint contains only that shipment's recipient and items.
- REQUESTED → PREPARING → COLLECTED → SHIPPING → DELIVERED. Collection requires a carrier and tracking number. State changes update inventory atomically and do not change GP.
- Customer cancellation increments the operations version. Collection and cancellation lock recipient/order/inventory in a consistent order; only one may succeed. Completed/cancelled shipments cannot return to earlier states.
- Customer shipment details display operator-entered carrier/tracking information and timestamps. It is not live carrier confirmation.

## API

All routes use JWT and active per-operation permission checks.

- GET /ops/capabilities
- GET /ops/requests/:key (original receipt; actor-scoped)
- GET /ops/catalog and /ops/catalog/:id
- POST /ops/catalog {config}
- POST /ops/catalog/:id/draft {expectedVersion,config}
- POST /ops/catalog/:id/publish {expectedVersion,confirmation:"판매 설정 적용"}
- POST /ops/catalog/:id/availability {expectedVersion,active}
- GET /ops/fulfillments[?status=…] and /ops/fulfillments/:id
- POST /ops/fulfillments/:id/status {expectedVersion,status,carrier?,trackingNumber?}

All POST requests require an Idempotency-Key UUID. Only collection accepts carrier/tracking fields. Carrier values are CJ, HANJIN, LOTTE, POST, LOGEN, OTHER. No external carrier API is called.

## Database and activation

Migration 1789484000000 is the 11th migration, following account/session/support changes. It creates permissions, request receipts, drafts and audit history, and adds fulfillment version/tracking columns. It does not create grants or change any existing sales probabilities. Down migration refuses to erase operations history.

Apply and verify all compiled migrations before starting the new application in an isolated test environment. Write operations require NODE_ENV=development/test, ENABLE_OPERATIONS_PREVIEW=true and ENABLE_LEGACY_TRANSACTIONS not true. Existing shipping, refund and payment flags stay separate. No production flag, operating database or user permission has been changed by this development work.

No public grant mechanism is added. A database administrator may provision a dedicated test operator with CATALOG and/or FULFILLMENT in operations_permissions after checking the intended account. Do not give these rights to all users or all support staff.

## Verification and remaining work

Build, TypeScript and 172 unit/HTTP/SQL checks pass across 23 suites. Nine new PGlite SQL checks exercise all 11 migrations, snapshots, request binding, stock floor, permissions, dispatch, cancellation and transactional rollback. Four HTTP checks cover authentication and nested input validation. Three real PostgreSQL concurrency tests are written; their execution status must be reported separately.

Not complete: physical warehouse stock ledger/procurement, card-enabled catalog changes, production activation, real carrier integration, tracking corrections/returns, label printing, automatic notifications, final account deletion/retention, verified payment-provider transactions, native app integration and device/store validation.

The web rehearsal stores catalog configuration and pending operation payloads locally for retry. Pending operations never contain recipient addresses, passwords or authentication tokens; collection retry may include carrier/tracking. Real user data is not copied into the rehearsal. Sandbox mode does not grant actual staff rights or dispatch parcels.
