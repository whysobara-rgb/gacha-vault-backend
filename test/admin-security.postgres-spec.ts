import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Controller, Get, Post, UseGuards, INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { User } from '../src/entities';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard';
import { AdminSecurityService } from '../src/modules/admin-security/admin-security.service';
import { AdminSecurityController } from '../src/modules/admin-security/admin-security.controller';
import { AdminSecurityInterceptor } from '../src/modules/admin-security/admin-security.interceptor';
import { AdminSecurityModule } from '../src/modules/admin-security/admin-security.module';
import { AppModule } from '../src/app.module';
import { otpAt, stateKey } from '../src/modules/admin-security/admin-security.policy';
import { OrdersService } from '../src/modules/orders/orders.service';
import { PaymentsService } from '../src/modules/commerce/payments.service';
import { RefundsService } from '../src/modules/commerce/refunds.service';
import { OperatorRefundsController } from '../src/modules/commerce/operator-refunds.controller';
import { ResponseTransformInterceptor } from '../src/common/interceptors/response-transform.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

let writes = 0;
@Controller() @UseGuards(JwtAuthGuard)
class Probes {
  @Get('owner/mfa-probe') owner() { return { allowed: true }; }
  @Get('ops/mfa-probe') ops() { return { allowed: true }; }
  @Get('staff/mfa-probe') staff() { return { allowed: true }; }
  @Post('owner/mfa-probe') write() { writes++; return { writes }; }
  @Get('mfa-public-probe') customer() { return { customer: true }; }
}
const name='gacha_mfa_'+randomUUID().replace(/-/g,'');
const local={type:'postgres' as const,host:'127.0.0.1',port:Number(process.env.TEST_POSTGRES_PORT??5432),username:'gacha_ci',password:'local-ci-only',ssl:false,synchronize:false,migrationsRun:false,dropSchema:false,logging:false as const,extra:{max:24,statement_timeout:12000}};
const admin=new DataSource({...local,database:'postgres'}),db=new DataSource({...dataSourceOptions,...local,database:name});
const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // Public RFC vector, only isolated test accounts.
const password='SYNTHETIC-mfa-password-1!';
jest.setTimeout(30000);
describe('admin MFA with real JWT, PostgreSQL and HTTP, no live provider',()=>{
  const env={...process.env}; let app:INestApplication, origin:string, jwt:JwtService, security:AdminSecurityService, created=false, cancel:jest.Mock, orders:OrdersService, payments:PaymentsService;
  let actors:any[]=[];
  beforeAll(async()=>{
    if(process.env.NODE_ENV!=='test'||process.env.TEST_POSTGRES!=='true')throw new Error('Isolated test opt-in required');
    Object.assign(process.env,{ENABLE_ADMIN_MFA_PREVIEW:'true',ENABLE_GP_ORDER_PREVIEW:'true',ENABLE_ORDER_REFUND_PREVIEW:'true',ENABLE_OPERATOR_REFUND_PREVIEW:'true',ENABLE_LEGACY_TRANSACTIONS:'false',REFUND_CALENDAR_JSON:JSON.stringify({coverageStart:'2026-01-01',coverageEnd:'2030-12-31',holidays:[]})});
    await admin.initialize(); await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created=true;
    await db.initialize(); await db.runMigrations({transaction:'all'});
    security=new AdminSecurityService(db); cancel=jest.fn();
    const provider:any={ready:()=>true,config:()=>({merchantId:'SYNTHETIC_MFA'}),confirm:async({transactionId}:any)=>({confirmed:true,transactionId}),cancel};
    orders=new OrdersService(db); payments=new PaymentsService(db,provider);
    const signing=randomUUID()+randomUUID(); jwt=new JwtService({secret:signing});
    const module=await Test.createTestingModule({imports:[PassportModule],controllers:[Probes,AdminSecurityController,OperatorRefundsController],providers:[JwtStrategy,
      {provide:ConfigService,useValue:new ConfigService({JWT_SECRET:signing})},{provide:getRepositoryToken(User),useValue:db.getRepository(User)},
      {provide:AdminSecurityService,useValue:security},{provide:RefundsService,useValue:new RefundsService(db,provider)},
      {provide:APP_INTERCEPTOR,useClass:AdminSecurityInterceptor}]}).compile();
    app=module.createNestApplication({logger:false}); app.useGlobalInterceptors(new ResponseTransformInterceptor()); app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0,'127.0.0.1'); origin=await app.getUrl();
  });
  beforeEach(()=>{actors=[];writes=0;cancel.mockReset();cancel.mockResolvedValue({confirmed:true,transactionId:randomUUID().replace(/-/g,'')});});
  afterAll(async()=>{try{if(app)await app.close();if(db.isInitialized)await db.destroy();if(created)await admin.query(`DROP DATABASE "${name}"`);}finally{if(admin.isInitialized)await admin.destroy();process.env=env;}});
  function config(){process.env.ADMIN_MFA_FACTORS_JSON=JSON.stringify({version:1,factors:actors.map((a,i)=>({userId:a.userId,keyId:'synthetic-key-'+a.userId,secret:a.secret}))});}
  async function account(role:string|null='OWNER'){
    const email=randomUUID()+'@example.invalid',hash=await bcrypt.hash(password,4);
    const [u]=await db.query(`INSERT INTO users(email,nickname,password,"coinBalance") VALUES($1,'synthetic-mfa',$2,10000) RETURNING id`,[email,hash]);
    if(role)await db.query('INSERT INTO operations_permissions(user_id,permission) VALUES($1,$2)',[u.id,role]);
    // Unique 160-bit test factor for each actor. RFC vector for first actor; deterministic variation thereafter.
    const s=actors.length===0?secret:('A'.repeat(31)+'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[actors.length]);
    const a={userId:u.id,email,authVersion:0,secret:s,token:jwt.sign({sub:u.id,av:0,jti:randomUUID(),role:'OWNER'},{expiresIn:'10m'})};
    actors.push(a);config();return a;
  }
  async function code(a:any,next=false){
    const [{step}]=await db.query('SELECT floor(extract(epoch FROM clock_timestamp())/30)::text AS step');
    return otpAt(a.secret,Number(step)+(next?1:0));
  }
  async function req(method:string,path:string,a?:any,body?:any,session?:string,proof?:string,key?:string){
    const headers:Record<string,string>={'content-type':'application/json'};
    if(a)headers.authorization='Bearer '+a.token;if(session)headers['x-admin-session']=session;if(proof)headers['x-admin-action']=proof;if(key)headers['idempotency-key']=key;
    const r=await fetch(origin+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
    return {status:r.status,body:await r.json() as any,cache:r.headers.get('cache-control')};
  }
  async function session(a:any){const r=await req('POST','/admin-security/session',a,{password,otp:await code(a)});expect(r.status).toBe(201);return r.body.data.proof as string;}
  const action=(body:any={},path='/owner/mfa-probe',key:string|null=null)=>({method:'POST',path,body,idempotencyKey:key});
  async function proof(a:any,s:string,d:any){const r=await req('POST','/admin-security/authorize',a,{password,otp:await code(a,true),action:d},s);expect(r.status).toBe(201);return r.body.data.proof as string;}
  async function mutate(id:string,a:any,patch:any){await db.query(`UPDATE operations_requests SET response=response||$1::jsonb WHERE actor_id=$2 AND request_key=$3`,[JSON.stringify(patch),a.userId,id.slice(0,36)]);}
  it('registers the protection module and global interceptor in the actual application',()=>{
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS,AppModule)).toContain(AdminSecurityModule);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS,AdminSecurityModule).some((p:any)=>p.provide===APP_INTERCEPTOR&&p.useClass===AdminSecurityInterceptor)).toBe(true);
  });
  it('rejects unauthenticated and non-administrator sessions despite a role claim',async()=>{
    const a=await account(null);expect((await req('POST','/admin-security/session',undefined,{password,otp:await code(a)})).status).toBe(401);
    expect((await req('POST','/admin-security/session',a,{password,otp:await code(a)})).status).toBe(403);
  });
  it('requires a configured factor without returning secrets in capabilities',async()=>{
    const a=await account();delete process.env.ADMIN_MFA_FACTORS_JSON;
    expect((await req('POST','/admin-security/session',a,{password,otp:await code(a)})).status).toBe(503);
    const c=await req('GET','/admin-security/capabilities',a);expect(c.status).toBe(200);expect(c.body.data.provisioned).toBe(false);expect(JSON.stringify(c.body)).not.toContain(secret);
  });
  it('requires password and OTP and persists failed attempts',async()=>{
    const a=await account();expect((await req('POST','/admin-security/session',a,{password:'incorrect',otp:await code(a)})).status).toBe(401);
    const [{response}]=await db.query('SELECT response FROM operations_requests WHERE actor_id=$1 AND request_key=$2',[a.userId,stateKey(a.userId)]);expect(response.failures).toBe(1);
    expect((await req('POST','/admin-security/session',a,{password,otp:'letters'})).status).toBe(400);
  });
  it('allows exactly one of six simultaneous uses of one OTP',async()=>{
    const a=await account(),otp=await code(a);const rows=await Promise.all(Array.from({length:6},()=>req('POST','/admin-security/session',a,{password,otp})));
    expect(rows.filter(r=>r.status===201)).toHaveLength(1);expect(rows.filter(r=>r.status===401)).toHaveLength(5);
  });
  it('rate limits repeated guesses durably across service instances',async()=>{
    const a=await account();for(let i=0;i<5;i++)expect((await req('POST','/admin-security/session',a,{password:'incorrect',otp:await code(a)})).status).toBe(401);
    await expect(new AdminSecurityService(db).issue(a,'Bearer '+a.token,password,await code(a))).rejects.toMatchObject({status:429});
  });
  it('protects owner, ops and staff reads, including mixed-case URL spelling',async()=>{
    const a=await account();for(const p of ['/owner/mfa-probe','/ops/mfa-probe','/staff/mfa-probe','/OwNeR/mfa-probe'])expect((await req('GET',p,a)).status).toBe(401);
    const s=await session(a);for(const p of ['/owner/mfa-probe','/ops/mfa-probe','/staff/mfa-probe']){const r=await req('GET',p,a,undefined,s);expect(r.status).toBe(200);expect(r.cache).toBe('no-store');}
    expect((await req('GET','/mfa-public-probe',a)).status).toBe(200);
  });
  it('binds additional authentication to the exact primary login token',async()=>{
    const a=await account(),s=await session(a);const second={...a,token:jwt.sign({sub:a.userId,av:0,jti:randomUUID()},{expiresIn:'10m'})};
    expect((await req('GET','/owner/mfa-probe',second,undefined,s)).status).toBe(401);
  });
  it('does not accept another operators factor or session',async()=>{
    const a=await account(),b=await account(),s=await session(a);
    expect((await req('POST','/admin-security/session',b,{password,otp:await code(a)})).status).toBe(401);
    expect((await req('GET','/owner/mfa-probe',b,undefined,s)).status).toBe(401);
  });
  it('invalidates sessions after password/session version revocation or role removal',async()=>{
    const a=await account(),s=await session(a);await db.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1',[a.userId]);
    expect((await req('GET','/owner/mfa-probe',a,undefined,s)).status).toBe(401);
    const b=await account(),t=await session(b);await db.query('UPDATE operations_permissions SET active=false WHERE user_id=$1',[b.userId]);
    expect((await req('GET','/owner/mfa-probe',b,undefined,t)).status).toBe(403);
  });
  it('invalidates sessions on factor rotation and explicit admin logout',async()=>{
    const a=await account(),s=await session(a);actors[0].secret='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';config();
    expect((await req('GET','/owner/mfa-probe',a,undefined,s)).status).toBe(401);
    const b=await account(),t=await session(b);expect((await req('DELETE','/admin-security/session',b,undefined,t)).status).toBe(200);
    expect((await req('GET','/owner/mfa-probe',b,undefined,t)).status).toBe(401);
  });
  it('rejects expired sessions using DB time even with a slow application clock',async()=>{
    const a=await account(),s=await session(a);await mutate(s,a,{expiresAt:1});const spy=jest.spyOn(Date,'now').mockReturnValue(0);
    try{expect((await req('GET','/owner/mfa-probe',a,undefined,s)).status).toBe(401);}finally{spy.mockRestore();}
  });
  it('requires fresh credentials for a write and rejects reusing the login OTP',async()=>{
    const a=await account(),s=await session(a);
    expect((await req('POST','/owner/mfa-probe',a,{},s)).status).toBe(401);
    expect((await req('POST','/admin-security/authorize',a,{password,otp:await code(a),action:action()},s)).status).toBe(401);
    expect(writes).toBe(0);
  });
  it('binds the exact action body, path and idempotency key',async()=>{
    const a=await account(),s=await session(a),key=randomUUID(),body={amount:100},p=await proof(a,s,action(body,'/owner/mfa-probe',key));
    expect((await req('POST','/owner/mfa-probe',a,{amount:101},s,p,key)).status).toBe(401);
    expect((await req('POST','/owner/mfa-probe',a,body,s,p,randomUUID())).status).toBe(401);
    expect((await req('POST','/owner/mfa-probe',a,body,s,p,key)).status).toBe(201);expect(writes).toBe(1);
  });
  it('consumes an action proof once across simultaneous HTTP attempts',async()=>{
    const a=await account(),s=await session(a),p=await proof(a,s,action());
    const results=await Promise.all(Array.from({length:6},()=>req('POST','/owner/mfa-probe',a,{},s,p)));
    expect(results.filter(r=>r.status===201)).toHaveLength(1);expect(results.filter(r=>r.status===401)).toHaveLength(5);expect(writes).toBe(1);
  });
  it('rejects expired action proofs and actions after session logout',async()=>{
    const a=await account(),s=await session(a),p=await proof(a,s,action());await mutate(p,a,{expiresAt:1});
    expect((await req('POST','/owner/mfa-probe',a,{},s,p)).status).toBe(401);
    await req('DELETE','/admin-security/session',a,undefined,s);expect((await req('POST','/owner/mfa-probe',a,{},s,p)).status).toBe(401);expect(writes).toBe(0);
  });
  it('stores only proof hashes and secret-free audit records',async()=>{
    const a=await account(),s=await session(a),p=await proof(a,s,action());
    const rows=await db.query('SELECT * FROM operations_requests WHERE actor_id=$1',[a.userId]),events=await db.query('SELECT detail,event FROM operations_events WHERE actor_id=$1',[a.userId]);
    const text=JSON.stringify([rows,events]);for(const value of [password,a.secret,a.token,s,p])expect(text).not.toContain(value);
    expect(events.some((e:any)=>e.event==='ADMIN_ACTION_AUTHORIZED')).toBe(true);
  });
  it('rolls back proof issuance and OTP consumption when the audit write fails',async()=>{
    const a=await account(),tag='mfa_fail_'+randomUUID().replace(/-/g,'');
    await db.query(`CREATE FUNCTION ${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_id=${Number(a.userId)} AND NEW.event='ADMIN_MFA_VERIFIED' THEN RAISE EXCEPTION 'synthetic MFA audit failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${tag} BEFORE INSERT ON operations_events FOR EACH ROW EXECUTE FUNCTION ${tag}()`);
    try{expect((await req('POST','/admin-security/session',a,{password,otp:await code(a)})).status).toBe(500);
      expect((await db.query('SELECT * FROM operations_requests WHERE actor_id=$1',[a.userId])).length).toBe(0);
    }finally{await db.query(`DROP TRIGGER ${tag} ON operations_events`);await db.query(`DROP FUNCTION ${tag}()`);}
    expect(await session(a)).toMatch(/\./);
  });
  it('cannot disable production protection by clearing preview flags',async()=>{
    const a=await account();const old=process.env.NODE_ENV;process.env.NODE_ENV='production';process.env.ENABLE_ADMIN_MFA_PREVIEW='false';
    try{expect((await req('GET','/owner/mfa-probe',a)).status).toBe(401);}finally{process.env.NODE_ENV=old;process.env.ENABLE_ADMIN_MFA_PREVIEW='true';}
  });
  it.each(['GP','KRW'])('protects an actual %s refund without weakening original-payment rules',async(currency)=>{
    const a=await account(),customer=await account(null);
    const [g]=await db.query(`INSERT INTO gachas(title,price,currency,"totalStock",sale_type,cash_enabled,cash_unit_price) VALUES('MFA refund',100,'GP',100,'STANDARD',true,100) RETURNING id`);
    const [i]=await db.query(`INSERT INTO items(name,"estimatedValue","isPremium","conversionGP") VALUES('synthetic item',1000,false,100) RETURNING id`);
    await db.query('INSERT INTO gacha_items(gacha_id,item_id,"probabilityPpm") VALUES($1,$2,1000000)',[g.id,i.id]);
    const odds=await orders.odds(g.id),dto={gachaId:g.id,quantity:1,expectedUnitPrice:100,expectedProbabilityVersion:odds.version};let order:any;
    if(currency==='GP')order=await orders.purchase(customer.userId,randomUUID(),dto);
    else{const intent=await payments.prepare(customer.userId,randomUUID(),dto);const paid=await payments.confirm(customer.userId,intent.paymentId,randomUUID().replace(/-/g,''),100);order=await orders.findOne(customer.userId,paid.orderId);}
    const body={orderId:order.orderId,capsuleIds:[order.capsules[0].id],expectedAmount:100,expectedCurrency:currency,reason:'synthetic customer request'},key=randomUUID(),s=await session(a);
    expect((await req('POST','/owner/refunds',a,body,s,undefined,key)).status).toBe(401);expect(cancel).not.toHaveBeenCalled();
    const p=await proof(a,s,action(body,'/owner/refunds',key));expect((await req('POST','/owner/refunds',a,body,s,p,key)).status).toBe(201);
    expect((await req('POST','/owner/refunds',a,body,s,p,key)).status).toBe(401);
    expect((await req('GET','/owner/refunds/by-request/'+key,a,undefined,s)).status).toBe(200);
    expect((await db.query('SELECT id FROM order_refunds WHERE order_id=$1',[order.orderId])).length).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(currency==='KRW'?1:0);
    const [balance]=await db.query('SELECT "coinBalance" AS n FROM users WHERE id=$1',[customer.userId]);expect(Number(balance.n)).toBe(10000);
  });
});
