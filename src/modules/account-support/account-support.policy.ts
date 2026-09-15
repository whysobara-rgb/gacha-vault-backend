import { EntityManager } from 'typeorm';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { conversionError as fail } from '../conversions/conversion.policy';
export { fail };
export function plain(
  value: unknown,
  min: number,
  max: number,
  multiline = false,
) {
  if (typeof value !== 'string') throw fail('입력 내용을 확인해주세요', 400);
  const s = value.trim();
  if (
    s.length < min ||
    s.length > max ||
    (multiline
      ? /[^\S\r\n\t ]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
      : /[\x00-\x1f\x7f]/
    ).test(s)
  )
    throw fail('입력 길이와 문자를 확인해주세요', 400);
  return s;
}
export function password(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 64 ||
    Buffer.byteLength(value, 'utf8') > 72 ||
    !/[A-Za-z]/.test(value) ||
    !/[0-9]/.test(value) ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw fail(
      '비밀번호는 영문·숫자를 포함한 8~64자, UTF-8 72바이트 이내로 입력해주세요',
      400,
    );
  return value;
}
export async function accountLock(m: EntityManager, actor: AuthenticatedUser) {
  const [u] = await m.query(
    'SELECT id,email,password,auth_version,"coinBalance" AS balance,password_check_failures,password_locked_until FROM users WHERE id=$1 FOR UPDATE',
    [actor.userId],
  );
  if (!u || u.auth_version !== (actor.authVersion ?? 0))
    throw fail('다시 로그인해주세요', 401);
  return u;
}
export async function staffAccess(m: EntityManager, id: number, lock = false) {
  const [r] = await m.query(
    `SELECT user_id FROM support_staff WHERE user_id=$1 AND active=true ${lock ? 'FOR SHARE' : ''}`,
    [id],
  );
  if (!r) throw fail('고객지원 운영 권한이 필요합니다', 403);
}
