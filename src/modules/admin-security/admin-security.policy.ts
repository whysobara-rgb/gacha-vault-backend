import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { HttpException } from '@nestjs/common';

export const adminError = (code: string, status = 401) => new HttpException({ message: '관리자 추가 인증을 확인해주세요', code }, status);
// Only explicit development/test may omit enforcement. Missing or misspelled env fails closed.
export const adminMfaRequired = () => !['development','test'].includes(process.env.NODE_ENV ?? '') || process.env.ENABLE_ADMIN_MFA_PREVIEW === 'true';
export const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
export const administrativePath = (path: string) => /^\/(owner|ops|staff)(\/|$)/.test(path);
export const stateKey = (id: number) => {
  const h = fingerprint('GACHA_ADMIN_AUTH_STATE_V1:' + id);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
export function decodeBase32(secret: string): Buffer {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{32,104}$/.test(secret)) throw adminError('MFA_CONFIGURATION_REQUIRED', 503);
  let bits = 0, value = 0; const bytes: number[] = [];
  for (const c of secret) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); value &= (1 << bits) - 1; }
  }
  if (value !== 0 || bytes.length < 20 || bytes.length > 64 || Math.ceil(bytes.length * 8 / 5) !== secret.length) throw adminError('MFA_CONFIGURATION_REQUIRED', 503);
  return Buffer.from(bytes);
}
/** RFC 4226/6238, SHA-1, 30-second step. No application clock is used by the verifier. */
export function otpAt(secret: string, counter: number, digits: 6 | 8 = 6): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw adminError('MFA_CLOCK_INVALID', 503);
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', decodeBase32(secret)).update(bytes).digest();
  const n = mac.readUInt32BE(mac[mac.length - 1] & 15) & 0x7fffffff;
  return String(n % (10 ** digits)).padStart(digits, '0');
}
export function matchOtp(secret: string, otp: string, milliseconds: number, lastStep: number): number | null {
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) return null;
  const current = Math.floor(milliseconds / 30000); let accepted: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0) continue;
    const match = timingSafeEqual(Buffer.from(otpAt(secret, step)), Buffer.from(otp));
    if (match && step > lastStep) accepted = step;
  }
  return accepted;
}
export type AdminFactor = { userId: number; keyId: string; secret: string; binding: string };
/** Provisioned out of band. Never supplied by a logged-in caller or returned by an API. */
export function configuredFactor(id: number): AdminFactor {
  let data: any;
  try {
    const raw = process.env.ADMIN_MFA_FACTORS_JSON;
    if (!raw || raw.length > 20000) throw new Error();
    data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.factors) || !data.factors.length || data.factors.length > 50) throw new Error();
    const users = new Set(), keys = new Set(), secrets = new Set();
    for (const f of data.factors) {
      if (!f || !Number.isSafeInteger(f.userId) || f.userId < 1 || typeof f.keyId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(f.keyId) || users.has(f.userId) || keys.has(f.keyId) || secrets.has(f.secret)) throw new Error();
      decodeBase32(f.secret); users.add(f.userId); keys.add(f.keyId); secrets.add(f.secret);
    }
  } catch { throw adminError('MFA_CONFIGURATION_REQUIRED', 503); }
  const f = data.factors.find((v: any) => v.userId === id);
  if (!f) throw adminError('MFA_FACTOR_NOT_PROVISIONED', 403);
  return { ...f, binding: fingerprint(JSON.stringify([f.userId, f.keyId, f.secret])) };
}
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 10) throw adminError('ACTION_INVALID', 400);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(v => canonical(v, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw adminError('ACTION_INVALID', 400);
      result[key] = canonical((value as Record<string, unknown>)[key], depth + 1);
    }
    return result;
  }
  throw adminError('ACTION_INVALID', 400);
}
export type AdminAction = { method: string; path: string; body: unknown; idempotencyKey: string | null };
export function actionHash(action: AdminAction): string {
  if (!action || typeof action !== 'object' || Object.keys(action).sort().join(',') !== 'body,idempotencyKey,method,path' || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(action.method) || typeof action.path !== 'string' || action.path.length > 512 || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(action.path) || !administrativePath(action.path)) throw adminError('ACTION_INVALID', 400);
  if (action.idempotencyKey !== null && (typeof action.idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(action.idempotencyKey))) throw adminError('ACTION_INVALID', 400);
  const encoded = JSON.stringify(canonical(action));
  if (Buffer.byteLength(encoded) > 32768) throw adminError('ACTION_TOO_LARGE', 400);
  return fingerprint(encoded);
}
export function bearerHash(header: unknown): string {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(header)) throw adminError('PRIMARY_SESSION_REQUIRED');
  return fingerprint(header.slice(7));
}
export function parseProof(token: unknown): { id: string; hash: string } {
  if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(token)) throw adminError('MFA_PROOF_REQUIRED');
  return { id: token.slice(0,36), hash: fingerprint(token) };
}
