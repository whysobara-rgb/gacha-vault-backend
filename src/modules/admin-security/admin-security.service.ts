import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcrypt';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { actionHash, AdminAction, adminError, adminMfaRequired, bearerHash, configuredFactor, fingerprint, matchOtp, parseProof, stateKey } from './admin-security.policy';

const CONTRACT = 'ADMIN_AUTH_V1', PERMISSION = 'ADMIN_AUTH';
@Injectable()
export class AdminSecurityService {
  constructor(private readonly db: DataSource) {}
  private async actor(m: EntityManager, a: AuthenticatedUser) {
    if (!a || !Number.isSafeInteger(a.userId) || a.userId < 1 || !Number.isSafeInteger(a.authVersion ?? 0)) throw adminError('PRIMARY_SESSION_REQUIRED');
    const [u] = await m.query('SELECT id,password,auth_version,password_locked_until FROM users WHERE id=$1 FOR UPDATE', [a.userId]);
    if (!u || u.auth_version !== (a.authVersion ?? 0)) throw adminError('PRIMARY_SESSION_REVOKED');
    const [r] = await m.query(`SELECT EXISTS(SELECT 1 FROM operations_permissions WHERE user_id=$1 AND active=true) OR EXISTS(SELECT 1 FROM support_staff WHERE user_id=$1 AND active=true) AS allowed`, [a.userId]);
    if (!r.allowed) throw adminError('ADMIN_ROLE_REQUIRED', 403);
    return u;
  }
  private async now(m: EntityManager): Promise<number> {
    const [r] = await m.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS ms');
    return Number(r.ms);
  }
  private async event(m: EntityManager, userId: number, event: string, id: string, detail: any = {}) {
    // Never record password, OTP, factor secret, bearer, or opaque proof.
    await m.query(`INSERT INTO operations_events(actor_id,target_type,target_id,event,detail) VALUES($1,'OWNER',$2,$3,$4::jsonb)`, [userId, id, event, JSON.stringify({ contract: CONTRACT, ...detail })]);
  }
  private async record(m: EntityManager, userId: number, id: string, hash: string, response: any) {
    const rows = await m.query(`WITH saved AS (INSERT INTO operations_requests(actor_id,request_key,permission,payload_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(actor_id,request_key) DO UPDATE SET payload_hash=EXCLUDED.payload_hash,response=EXCLUDED.response
      WHERE operations_requests.permission=EXCLUDED.permission RETURNING request_key) SELECT request_key FROM saved`, [userId, id, PERMISSION, hash, JSON.stringify(response)]);
    if (rows.length !== 1) throw adminError('MFA_LEDGER_CONFLICT', 503);
  }
  private async validate(m: EntityManager, a: AuthenticatedUser, primary: string, proof: unknown, type: 'SESSION' | 'ACTION') {
    const key = parseProof(proof), factor = configuredFactor(a.userId);
    const [r] = await m.query('SELECT payload_hash,response FROM operations_requests WHERE actor_id=$1 AND request_key=$2 AND permission=$3', [a.userId, key.id, PERMISSION]);
    const x = r?.response, now = await this.now(m);
    if (!r || !/^[0-9a-f]{64}$/.test(r.payload_hash) || !timingSafeEqual(Buffer.from(r.payload_hash), Buffer.from(key.hash)) || x?.contract !== CONTRACT || x.type !== type || x.authVersion !== (a.authVersion ?? 0) || x.primary !== primary || x.factor !== factor.binding || x.revoked || !Number.isSafeInteger(x.expiresAt) || x.expiresAt <= now) throw adminError('MFA_PROOF_INVALID');
    return { id: key.id, hash: key.hash, value: x };
  }
  async capabilities(a: AuthenticatedUser) {
    return this.db.transaction(async m => {
      await this.actor(m, a); let provisioned = false;
      try { configuredFactor(a.userId); provisioned = true; } catch { /* Never disclose config. */ }
      return { contract: CONTRACT, required: adminMfaRequired(), provisioned, sessionSeconds: 300, actionSeconds: 60, provisioning: 'OUT_OF_BAND', recoveryViaApi: false, phishingResistant: false, commerceEnabledByMfa: false };
    });
  }
  async issue(a: AuthenticatedUser, authorization: unknown, password: string, otp: string, session?: unknown, action?: AdminAction) {
    if (!adminMfaRequired()) throw adminError('MFA_PREVIEW_NOT_ENABLED', 503);
    const primary = bearerHash(authorization), requested = action === undefined ? null : actionHash(action);
    if (typeof password !== 'string' || password.length < 1 || password.length > 64 || Buffer.byteLength(password) > 72 || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) throw adminError('MFA_INPUT_INVALID', 400);
    const result = await this.db.transaction(async m => {
      const u = await this.actor(m, a), factor = configuredFactor(a.userId);
      const parent = requested ? await this.validate(m, a, primary, session, 'SESSION') : null;
      const id = stateKey(a.userId);
      const [row] = await m.query('SELECT permission,response FROM operations_requests WHERE actor_id=$1 AND request_key=$2', [a.userId, id]);
      let state = row?.response ?? { contract: CONTRACT, type: 'STATE', lastStep: -1, failures: 0, windowStart: 0, lockedUntil: 0 };
      if (row && (row.permission !== PERMISSION || state.contract !== CONTRACT || state.type !== 'STATE' || !Number.isSafeInteger(state.lastStep) || !Number.isSafeInteger(state.failures) || !Number.isSafeInteger(state.lockedUntil) || !Number.isSafeInteger(state.windowStart))) throw adminError('MFA_LEDGER_INVALID', 503);
      let now = await this.now(m);
      if (state.lockedUntil > now || (u.password_locked_until && new Date(u.password_locked_until).getTime() > now)) throw adminError('MFA_RATE_LIMITED', 429);
      if (now - state.windowStart >= 900000) state = { ...state, failures: 0, lockedUntil: 0, windowStart: now };
      const passwordOk = !!u.password && await bcrypt.compare(password, u.password);
      now = await this.now(m); // Check expiry and OTP after lock waits and password hashing.
      if (parent && parent.value.expiresAt <= now) throw adminError('MFA_PROOF_INVALID');
      const step = matchOtp(factor.secret, otp, now, state.lastStep);
      if (!passwordOk || step === null) {
        const failures = state.failures + 1;
        await this.record(m, a.userId, id, fingerprint('STATE'), { ...state, failures, lockedUntil: failures >= 5 ? now + 900000 : 0 });
        await this.event(m, a.userId, 'ADMIN_MFA_FAILED', id);
        return { denied: true as const };
      }
      await this.record(m, a.userId, id, fingerprint('STATE'), { ...state, lastStep: step, failures: 0, lockedUntil: 0, windowStart: now });
      const proofId = randomUUID(), proof = proofId + '.' + randomBytes(32).toString('base64url');
      const expiresAt = Math.min(now + (requested ? 60000 : 300000), parent?.value.expiresAt ?? Infinity);
      await this.record(m, a.userId, proofId, fingerprint(proof), { contract: CONTRACT, type: requested ? 'ACTION' : 'SESSION', authVersion: a.authVersion ?? 0, primary, factor: factor.binding, expiresAt, revoked: false, ...(parent ? { parent: parent.id, actionHash: requested, consumed: false } : {}) });
      await this.event(m, a.userId, requested ? 'ADMIN_ACTION_AUTHORIZED' : 'ADMIN_MFA_VERIFIED', proofId, requested ? { actionHash: requested } : {});
      return { denied: false as const, data: { contract: CONTRACT, proof, expiresAt: new Date(expiresAt).toISOString(), kind: requested ? 'ACTION' : 'SESSION', singleUse: !!requested } };
    });
    // Failed-attempt counters must commit; do not throw from inside that transaction.
    if (result.denied) throw adminError('MFA_CREDENTIALS_INVALID');
    return result.data;
  }
  async authorize(a: AuthenticatedUser, authorization: unknown, session: unknown, proof?: unknown, action?: AdminAction) {
    const primary = bearerHash(authorization);
    return this.db.transaction(async m => {
      await this.actor(m, a);
      const s = await this.validate(m, a, primary, session, 'SESSION');
      if (action) {
        const p = await this.validate(m, a, primary, proof, 'ACTION');
        if (p.value.parent !== s.id || p.value.actionHash !== actionHash(action) || p.value.consumed) throw adminError('MFA_ACTION_MISMATCH');
        await this.record(m, a.userId, p.id, p.hash, { ...p.value, consumed: true });
        await this.event(m, a.userId, 'ADMIN_ACTION_CONSUMED', p.id, { actionHash: p.value.actionHash });
      }
      return true;
    });
  }
  async revoke(a: AuthenticatedUser, authorization: unknown, session: unknown) {
    const primary = bearerHash(authorization);
    return this.db.transaction(async m => {
      await this.actor(m, a); const s = await this.validate(m, a, primary, session, 'SESSION');
      await this.record(m, a.userId, s.id, s.hash, { ...s.value, revoked: true });
      await this.event(m, a.userId, 'ADMIN_MFA_REVOKED', s.id);
      return { revoked: true };
    });
  }
  /** Primary permission check before config/token errors, without trusting role claims. */
  async checkActor(a: AuthenticatedUser) { return this.db.transaction(async m => { await this.actor(m, a); }); }
}
