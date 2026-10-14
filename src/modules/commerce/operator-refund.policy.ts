import { EntityManager } from 'typeorm';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { conversionError as fail } from '../conversions/conversion.policy';
import { preview, requireRefund } from './commerce.policy';

export const OPERATOR_REFUND_CONTRACT = 'OPERATOR_REFUND_V1';
export type OperatorRefundContext = {
  actor: AuthenticatedUser;
  requestKey: string;
  currency: 'GP' | 'KRW';
};
export function operatorRefundEnabled() {
  return preview() && process.env.ENABLE_ORDER_REFUND_PREVIEW === 'true' &&
    process.env.ENABLE_OPERATOR_REFUND_PREVIEW === 'true';
}
export function requireOperatorRefund() {
  requireRefund();
  if (!operatorRefundEnabled()) throw fail('운영자 환불은 시험 환경에서만 허용됩니다', 503);
}
/** Claims are not permissions: always check the stored role and session version. */
export async function assertRefundOwner(m: EntityManager, actor: AuthenticatedUser, lock = false) {
  if (!actor || !Number.isSafeInteger(actor.userId) || actor.userId < 1 ||
      !Number.isSafeInteger(actor.authVersion ?? 0) || (actor.authVersion ?? 0) < 0)
    throw fail('다시 로그인해주세요', 401);
  const [user] = await m.query('SELECT auth_version FROM users WHERE id=$1', [actor.userId]);
  if (!user || user.auth_version !== (actor.authVersion ?? 0)) throw fail('다시 로그인해주세요', 401);
  const [permission] = await m.query(
    `SELECT user_id FROM operations_permissions WHERE user_id=$1 AND permission='OWNER' AND active=true ${lock ? 'FOR SHARE' : ''}`,
    [actor.userId]);
  if (!permission) throw fail('소유자 환불 권한이 필요합니다', 403);
}
export async function lockRefundParticipants(m: EntityManager, actorId: number, customerId: number) {
  // Also used for already-authorized PG completion, without a new role decision.
  await m.query('SELECT id FROM users WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE',
    [[...new Set([actorId, customerId])]]);
}
export async function lockRefundActors(m: EntityManager, actor: AuthenticatedUser, customerId: number) {
  // Same ordering as other operator changes, including self-refunds.
  await lockRefundParticipants(m, actor.userId, customerId);
  await assertRefundOwner(m, actor, true);
}
export async function operatorRefundEvent(
  m: EntityManager, context: OperatorRefundContext | undefined,
  refundId: string, event: 'REFUND_REQUESTED' | 'REFUND_APPROVED' | 'REFUND_UNKNOWN' | 'REFUND_SUCCEEDED',
  detail: Record<string, unknown>,
) {
  if (!context) return;
  // Insert inside the same transaction as the status/ledger change. Failure is
  // not swallowed: no unaudited local success or PG dispatch is permitted.
  await m.query(`INSERT INTO operations_events(actor_id,target_type,target_id,event,detail)
    VALUES($1,'OWNER',$2,$3,$4)`, [context.actor.userId, refundId, event,
    JSON.stringify({ contract: OPERATOR_REFUND_CONTRACT, requestKey: context.requestKey, ...detail })]);
}
