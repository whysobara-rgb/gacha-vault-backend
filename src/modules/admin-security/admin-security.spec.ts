import { actionHash, administrativePath, adminMfaRequired, configuredFactor, decodeBase32, matchOtp, otpAt, parseProof, stateKey } from './admin-security.policy';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // Public RFC test vector, never an operational factor.
describe('administrator MFA cryptographic and policy boundaries', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });
  it.each([[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])('matches RFC6238 SHA1 vector at %s', (seconds, code) => {
    expect(otpAt(secret, Math.floor(Number(seconds)/30), 8)).toBe(code);
  });
  it('rejects a previously used or out-of-window OTP', () => {
    const time = 1234567890000, step = Math.floor(time/30000), code = otpAt(secret, step);
    expect(matchOtp(secret, code, time, step-1)).toBe(step);
    expect(matchOtp(secret, code, time, step)).toBeNull();
    expect(matchOtp(secret, otpAt(secret, step-2), time, -1)).toBeNull();
    expect(matchOtp(secret, '12345', time, -1)).toBeNull();
  });
  it('bounds clock drift to one step in either direction', () => {
    const time = 1234567890000, s = Math.floor(time/30000);
    expect(matchOtp(secret, otpAt(secret,s-1), time, s-2)).toBe(s-1);
    expect(matchOtp(secret, otpAt(secret,s+1), time, s-1)).toBe(s+1);
  });
  it('never treats missing or malformed factor config as a bypass', () => {
    for (const raw of ['', '{bad', '{}', JSON.stringify({version:1,factors:[]})]) {
      process.env.ADMIN_MFA_FACTORS_JSON=raw; expect(()=>configuredFactor(1)).toThrow();
    }
  });
  it('binds a factor to a specific operator and rejects duplicated factors', () => {
    const f={userId:1,keyId:'test-factor-1',secret};
    process.env.ADMIN_MFA_FACTORS_JSON=JSON.stringify({version:1,factors:[f]});
    expect(configuredFactor(1).binding).toMatch(/^[a-f0-9]{64}$/);
    expect(()=>configuredFactor(2)).toThrow();
    process.env.ADMIN_MFA_FACTORS_JSON=JSON.stringify({version:1,factors:[f,{...f,userId:2,keyId:'test-factor-2'}]});
    expect(()=>configuredFactor(1)).toThrow();
  });
  it('rejects malformed or short base32 secrets', () => {
    for(const value of ['abc','A'.repeat(8),'0'.repeat(32),' '+secret,secret+'=']) expect(()=>decodeBase32(value)).toThrow();
  });
  it('production cannot opt out with the preview flag', () => {
    process.env.NODE_ENV='production'; process.env.ENABLE_ADMIN_MFA_PREVIEW='false'; expect(adminMfaRequired()).toBe(true);
    process.env.NODE_ENV='test'; expect(adminMfaRequired()).toBe(false);
    process.env.ENABLE_ADMIN_MFA_PREVIEW='true'; expect(adminMfaRequired()).toBe(true);
  });
  it('distinguishes administrative paths from customer paths', () => {
    for(const path of ['/owner','/owner/refunds','/ops/catalog','/staff/support/tickets']) expect(administrativePath(path)).toBe(true);
    for(const path of ['/owners','/support/tickets','/admin-security/session']) expect(administrativePath(path)).toBe(false);
  });
  it('binds method, path, body and request key with canonical object ordering', () => {
    const a={method:'POST',path:'/owner/refunds',body:{order:'a',amount:100},idempotencyKey:null};
    expect(actionHash(a)).toBe(actionHash({...a,body:{amount:100,order:'a'}}));
    for(const b of [{...a,method:'DELETE'},{...a,path:'/ops/catalog'},{...a,body:{order:'a',amount:101}},{...a,idempotencyKey:'11111111-1111-4111-8111-111111111111'}]) expect(actionHash(a)).not.toBe(actionHash(b));
  });
  it('rejects ambiguous action paths, query strings and unsupported values', () => {
    const a={method:'POST',path:'/owner/refunds',body:{},idempotencyKey:null};
    for(const path of ['/owner//refunds','/owner/refunds/','/owner/refunds?x=1','/owner/%72efunds','https://bad.invalid/owner','/account/password']) expect(()=>actionHash({...a,path})).toThrow();
    expect(()=>actionHash({...a,body:{x:undefined}})).toThrow();
    expect(()=>actionHash({...a,body:{x:'a'.repeat(40000)}})).toThrow();
    expect(()=>actionHash({...a,body:JSON.parse('{"__proto__":1}')})).toThrow();
  });
  it('requires a high-entropy opaque proof and separate reserved state keys', () => {
    expect(()=>parseProof('123456')).toThrow();
    expect(stateKey(1)).not.toBe(stateKey(2)); expect(stateKey(1)).toMatch(/^[a-f0-9-]{14}5/);
  });
});
