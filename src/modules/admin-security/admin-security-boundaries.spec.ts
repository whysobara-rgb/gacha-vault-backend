import { adminMfaRequired, decodeBase32 } from './admin-security.policy';
describe('MFA configuration cannot silently weaken enforcement',()=>{
  const env={...process.env}; afterEach(()=>{process.env={...env};});
  it('requires MFA for absent and misspelled execution environments',()=>{
    process.env.ENABLE_ADMIN_MFA_PREVIEW='false';
    delete process.env.NODE_ENV;expect(adminMfaRequired()).toBe(true);
    for(const value of ['Production','prod','', 'staging']){process.env.NODE_ENV=value;expect(adminMfaRequired()).toBe(true);}
  });
  it('rejects redundant base32 padding bits instead of accepting equivalent key spellings',()=>{
    const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(decodeBase32(secret).length).toBe(20);
    expect(()=>decodeBase32(secret+'A')).toThrow();
  });
});
