# Step 4d — email verification and account recovery

Source implementation and offline verification are complete. Real email delivery and production deployment are pending; no real emails were sent during development.

## Behavior

- Public reset requests always return the same acknowledgement and queue encrypted work before any account lookup. Unknown accounts and social-only accounts receive no reset email. Existing account email spelling is matched exactly, consistent with the current login behavior; no account email addresses were rewritten.
- Signed-in users request verification for their own stored email address. A request body cannot select another recipient or redirect origin.
- 256-bit cryptographically random links expire after 15 minutes (reset) or 30 minutes (verification). Only the SHA-256 token hash is stored in the challenge table. Mail payloads are encrypted with AES-256-GCM and bound to the individual job ID.
- Tokens bind to account ID, email and authentication version. A reset atomically updates the bcrypt password, increments auth_version, clears password-check lockout, verifies the email and consumes all outstanding account links. GP and inventory are unchanged. Existing sessions cannot authenticate afterwards. Verification consumes all verification links and does not confer age or identity verification.
- Mail is generated and sent by a leased outbox worker. Provider calls happen outside database transactions. Retries use an unchanged message and stable Resend idempotency key, bounded to six attempts and a 30-minute queue lifetime. Leases recover after two minutes. Sent, cancelled, exhausted and expired jobs clear encrypted payloads when processed; no public outbox or token endpoint exists.
- Three requests per email per 15 minutes and 300 globally per minute are persisted under HMAC bucket identifiers. Rate-limited addresses receive the same acknowledgement. Requests do not lock the account. Perimeter traffic controls and production-volume tuning remain release work.
- A password reset also queues a security notice without the password. No automatic login occurs.

## Configuration and rollout

Apply migration 13 before the corresponding server build. `/health/ready` checks the exact manifest. No schema synchronization, production data writes or permission grants were performed in this step.

Required explicit deployment settings:

| Variable | Meaning |
| --- | --- |
| ENABLE_ACCOUNT_RECOVERY | `true` only after staging review |
| AUTH_MAIL_DELIVERY_ENABLED | `true` to allow the worker and APIs |
| AUTH_MAIL_ENCRYPTION_KEY | A separately generated 32-byte key in canonical Base64; not a JWT secret |
| AUTH_PUBLIC_WEB_ORIGIN | Reviewed HTTPS origin, with no credentials, path, query or fragment |
| AUTH_MAIL_FROM | Verified sender email address |
| RESEND_API_KEY | Scoped server-side provider key |

Missing/invalid configuration disables capabilities and returns a service-preparation response. Do not put these settings in frontend code. Configure the provider's sender domain, use staging addresses and verify inbox/spam handling before real activation. Key rotation must drain or deliberately retire outstanding jobs before replacing the encryption key. Failed jobs retain status/provider IDs for monitoring, not plaintext mail. No billing plan was selected or purchased.

The web uses fragment links, strips real tokens from the address bar after loading, holds them only in memory and submits tokens via fixed POST endpoints. Password inputs are cleared; neither passwords nor real recovery tokens enter browser storage. An uncertain completion response is not labelled success: users can try the new password or request another link. A consumed token cannot be replayed to reset the password again.

## Local rehearsal

The demo mailbox uses the reserved address `collector@gachi.example` and memory-only links. Refreshing loses demo mail. Demo passwords are validated but never stored or applied to real accounts. The simulator changes a security generation and verification marker only; it does not pretend to provide real email authentication.

## Verification

- 200 unit/HTTP/SQL/provider-boundary tests across 28 suites passed. All 13 migrations apply in PGlite.
- Added PostgreSQL multi-connection tests for one-time token consumption and one-worker email leases. These are prepared for CI; they have not run in this workspace.
- Browser/device checks and actual provider delivery are still pending.

References used for implementation: [OWASP password recovery](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html), [Resend send-email API and idempotency header](https://resend.com/docs/api-reference/emails/send-email). Provider idempotency retention is 24 hours; this worker's retry lifetime is shorter.
