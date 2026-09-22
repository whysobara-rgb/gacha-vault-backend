import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'crypto';
import { isEmail } from 'class-validator';
import { fail } from '../account-support/account-support.policy';
export type Purpose = 'RESET' | 'VERIFY';
export function recoveryConfig(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.ENABLE_ACCOUNT_RECOVERY !== 'true' ||
    env.AUTH_MAIL_DELIVERY_ENABLED !== 'true'
  )
    return null;
  try {
    const raw = env.AUTH_MAIL_ENCRYPTION_KEY || '',
      key = Buffer.from(raw, 'base64'),
      url = new URL(env.AUTH_PUBLIC_WEB_ORIGIN || '');
    if (
      key.length !== 32 ||
      key.toString('base64') !== raw ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !isEmail(env.AUTH_MAIL_FROM || '') ||
      !env.RESEND_API_KEY ||
      env.RESEND_API_KEY.length < 12
    )
      return null;
    return {
      key,
      origin: url.origin,
      from: env.AUTH_MAIL_FROM,
      apiKey: env.RESEND_API_KEY,
    };
  } catch {
    return null;
  }
}
export function requireRecovery() {
  const c = recoveryConfig();
  if (!c)
    throw fail('이메일 인증·계정 복구 서비스 연결을 준비하고 있습니다', 503);
  return c;
}
export function emailInput(s: string) {
  if (typeof s !== 'string' || s.length > 255 || !isEmail(s.trim()))
    throw fail('가입한 이메일 주소를 확인해주세요', 400);
  return s.trim();
}
export function tokenHash(s: string) {
  if (typeof s !== 'string' || !/^([a-f0-9]{64})$/.test(s))
    throw fail(
      '만료되었거나 사용할 수 없는 링크입니다. 다시 요청해주세요',
      400,
    );
  return createHash('sha256').update(s).digest('hex');
}
export function seal(value: unknown, key: Buffer, context: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function unseal(value: string, key: Buffer, context: string) {
  const b = Buffer.from(value, 'base64');
  if (b.length < 29) throw new Error('Invalid encrypted mail');
  const cipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(b.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(
      'utf8',
    ),
  );
}
export function bucket(value: string, key: Buffer) {
  return createHmac('sha256', key)
    .update('gachi-recovery:' + value)
    .digest('hex');
}
export const accepted = {
  accepted: true,
  message:
    '가입된 이메일이라면 안내 메일을 보내드립니다. 잠시 후 받은편지함과 스팸함을 확인해주세요.',
};
