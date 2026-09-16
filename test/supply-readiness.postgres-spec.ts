import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { User } from '../src/entities';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { OperationsService } from '../src/modules/operations/operations.service';
import { SupplyReadinessService } from '../src/modules/owner/supply-readiness.service';
import { SupplyReadinessController } from '../src/modules/owner/supply-readiness.controller';
import { OrdersService } from '../src/modules/orders/orders.service';
import { PaymentsService } from '../src/modules/commerce/payments.service';

const local={type:'postgres' as const,host:'127.0.0.1',port:Number(process.env.TEST_POSTGRES_PORT||5432),username:'gacha_ci',password:'local-ci-only',ssl:false,synchronize:false,extra:{max:8,statement_timeout:10000}};
const database='gacha_supply_'+randomUUID().replace(/-/g,'');
const admin=new DataSource({...local,database:'postgres'});
const db=new DataSource({...dataSourceOptions,...local,database});
const jwtSecret=randomUUID()+randomUUID();
const jwt=new JwtService({secret:jwtSecret});
let service:SupplyReadinessService, app:any, origin:string, owner:number, buyer:number;
const originalEnv={...process.env};
const actor=()=>({userId:owner,email:'owner@example.invalid',authVersion:0});
async function addUser(){return (await db.query(`INSERT INTO users(email,nickname,"coinBalance") VALUES($1,'supply-test',100000) RETURNING id`,[randomUUID()+'@example.invalid']))[0].id as number;}
async function fixture(){
  const [s]=await db.query(`INSERT INTO warehouse_skus(code,name,on_hand) VALUES($1,'synthetic SKU',2) RETURNING id`,[randomUUID()]);
  const [i]=await db.query(`INSERT INTO items(name,rarity,"estimatedValue","isPremium","conversionGP",fulfillment_type,shipping_enabled,warehouse_sku_id) VALUES('synthetic item','N',100,false,10,'PHYSICAL',true,$1) RETURNING id`,[s.id]);
  return {sku:s.id,item:i.id};
}
async function inventory(itemId:number,status='STORED'){
  return (await db.query('INSERT INTO inventory_items(user_id,item_id,status) VALUES($1,$2,$3) RETURNING id',[buyer,itemId,status]))[0].id as number;
}
async function order(itemId:number,quantity=2){
  const [g]=await db.query(`INSERT INTO gachas(title,price,currency,"totalStock",sale_type,cash_enabled,cash_unit_price) VALUES('synthetic',100,'GP',100,'STANDARD',true,100) RETURNING id`);
  await db.query(`INSERT INTO gacha_items(gacha_id,item_id,"probabilityPpm") VALUES($1,$2,1000000)`,[g.id,itemId]);
  const orders=new OrdersService(db);const odds=await orders.odds(g.id);
  const dto={gachaId:g.id,quantity,expectedUnitPrice:100,expectedProbabilityVersion:odds.version};
  return {g:g.id,dto,orders,o:await orders.purchase(buyer,randomUUID(),dto)};
}
describe('owner supply readiness with real PostgreSQL and HTTP authentication',()=>{
  beforeAll(async()=>{
    if(process.env.NODE_ENV!=='test'||process.env.TEST_POSTGRES!=='true')throw new Error('Local synthetic test DB required');
    Object.assign(process.env,{ENABLE_GP_ORDER_PREVIEW:'true',ENABLE_LEGACY_TRANSACTIONS:'false',REFUND_CALENDAR_JSON:JSON.stringify({coverageStart:'2026-01-01',coverageEnd:'2030-12-31',holidays:[]})});
    await admin.initialize();await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);await db.initialize();await db.runMigrations({transaction:'all'});
    owner=await addUser();buyer=await addUser();
    await db.query("INSERT INTO operations_permissions(user_id,permission,active) VALUES($1,'OWNER',true)",[owner]);
    service=new SupplyReadinessService(db,new OperationsService(db));
    const mod=await Test.createTestingModule({imports:[PassportModule],controllers:[SupplyReadinessController],providers:[JwtStrategy,{provide:ConfigService,useValue:new ConfigService({JWT_SECRET:jwtSecret})},{provide:getRepositoryToken(User),useValue:db.getRepository(User)},{provide:SupplyReadinessService,useValue:service}]}).compile();
    app=mod.createNestApplication({logger:false});await app.listen(0,'127.0.0.1');origin=await app.getUrl();
  },30000);
  afterAll(async()=>{try{if(app)await app.close();if(db.isInitialized)await db.destroy();if(admin.isInitialized)await admin.query(`DROP DATABASE "${database}"`);}finally{if(admin.isInitialized)await admin.destroy();process.env=originalEnv;}});
  async function http(token?:string){const r=await fetch(origin+'/owner/supply-readiness',{headers:token?{authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(10000)});return {status:r.status,cache:r.headers.get('cache-control'),body:await r.json()};}
  it('rejects anonymous and ordinary users even with forged role claims',async()=>{
    expect((await http()).status).toBe(401);
    expect((await http(jwt.sign({sub:buyer,av:0,role:'OWNER'}))).status).toBe(403);
    await expect(service.report({userId:buyer,email:'x@example.invalid',authVersion:0})).rejects.toMatchObject({status:403});
  });
  it('returns no-store aggregate data in a read-only transaction with no user identifiers',async()=>{
    const r=await http(jwt.sign({sub:owner,av:0}));expect(r.status).toBe(200);expect(r.cache).toBe('no-store');
    expect(r.body).toMatchObject({contract:'SUPPLY_READINESS_V1',databaseReadOnly:true,productionReady:false});
    const text=JSON.stringify(r.body);expect(text).not.toContain('userId');expect(text).not.toContain('@example.invalid');expect(text).not.toContain('idempotency');
  });
  it('counts locked awards but excludes already shipped and delivered items',async()=>{
    const f=await fixture();const id=await inventory(f.item);await db.query('UPDATE inventory_items SET "isLocked"=true WHERE id=$1',[id]);
    await inventory(f.item,'SHIPPING');await inventory(f.item,'DELIVERED');
    const r=await service.report(actor());expect(r.skus.find(s=>s.skuId===f.sku)!.awardedAwaitingDispatch).toBe('1');
  });
  it('uses immutable purchased snapshots even after live catalog probabilities change',async()=>{
    const f=await fixture(),q=await order(f.item);
    await db.query('DELETE FROM gacha_items WHERE gacha_id=$1',[q.g]);
    await db.query("UPDATE owned_capsules SET status='REFUND_PENDING' WHERE id=$1",[q.o.capsules[0].id]);
    const before=await db.query('SELECT id,"coinBalance"::text AS balance FROM users ORDER BY id');
    const r=await service.report(actor());expect(r.skus.find(s=>s.skuId===f.sku)!.pendingDrawUpperBound).toBe('2');
    expect(await db.query('SELECT id,"coinBalance"::text AS balance FROM users ORDER BY id')).toEqual(before);
    expect((await db.query('SELECT probability_version FROM capsule_orders WHERE id=$1',[q.o.orderId]))[0].probability_version).toBe(q.dto.expectedProbabilityVersion);
  });
  it('keeps unconfirmed card exposure without double-counting existing orders',async()=>{
    const f=await fixture(),q=await order(f.item,1);
    const p=new PaymentsService(db,{ready:()=>true,config:()=>({merchantId:'SYNTHETIC'})} as any);
    const prepared=await p.prepare(buyer,randomUUID(),q.dto);
    let r=await service.report(actor());expect(r.skus.find(s=>s.skuId===f.sku)!.pendingDrawUpperBound).toBe('2');
    await db.query("UPDATE payment_intents SET expires_at=now()-interval '1 hour' WHERE id=$1",[prepared.paymentId]);
    r=await service.report(actor());expect(r.skus.find(s=>s.skuId===f.sku)!.pendingDrawUpperBound).toBe('1');
    await db.query("UPDATE payment_intents SET status='UNKNOWN' WHERE id=$1",[prepared.paymentId]);
    r=await service.report(actor());expect(r.skus.find(s=>s.skuId===f.sku)!.pendingDrawUpperBound).toBe('2');
  });
  it('includes a conversion restoration window and excludes it only after expiry',async()=>{
    const f=await fixture(),id=await inventory(f.item,'CONVERTED'),cid=randomUUID();
    const [tx]=await db.query(`INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",description) VALUES($1,'EARN',10,100000,'synthetic') RETURNING id`,[buyer]);
    await db.query(`INSERT INTO inventory_conversions(id,user_id,idempotency_key,request_hash,total_gp,balance_after,spend_version,policy,status,wallet_transaction_id,restore_until) VALUES($1,$2,$3,$4,10,100000,0,'{}','CONVERTED',$5,now()+interval '1 hour')`,[cid,buyer,randomUUID(),'a'.repeat(64),tx.id]);
    await db.query("INSERT INTO inventory_conversion_items(conversion_id,inventory_item_id,prize,amount_gp) VALUES($1,$2,'{}',10)",[cid,id]);
    expect((await service.report(actor())).skus.find(s=>s.skuId===f.sku)!.restoreWindowUpperBound).toBe('1');
    await db.query("UPDATE inventory_conversions SET restore_until=now()-interval '1 second' WHERE id=$1",[cid]);
    expect((await service.report(actor())).skus.find(s=>s.skuId===f.sku)!.restoreWindowUpperBound).toBe('0');
  });
  it('flags missing physical links instead of treating zero mapped stock as safe',async()=>{
    const f=await fixture();await inventory(f.item);await db.query('UPDATE items SET warehouse_sku_id=NULL WHERE id=$1',[f.item]);
    const r=await service.report(actor());expect(r.physicalCoverageComplete).toBe(false);expect(r.itemsNeedingReview).toContainEqual({itemId:f.item,reasons:['SKU_LINK_MISSING']});
  });
  it('does not double-count reserved shipments or accept an inconsistent reservation',async()=>{
    const f=await fixture(),iid=await inventory(f.item,'SHIPPING_REQUESTED'),qid=randomUUID(),fid=randomUUID();
    const [tx]=await db.query(`INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",description) VALUES($1,'USE',0,100000,'synthetic') RETURNING id`,[buyer]);
    await db.query(`INSERT INTO fulfillment_quotes(id,user_id,inventory_item_ids,recipient,items,fee_gp,rate_version,zone,expires_at) VALUES($1,$2,$3,'{}','[]',0,$4,'{}',now()+interval '1 hour')`,[qid,buyer,[iid],'a'.repeat(64)]);
    await db.query(`INSERT INTO fulfillment_orders(id,user_id,idempotency_key,quote_id,recipient,fee_gp,zone,status,wallet_transaction_id,balance_after) VALUES($1,$2,$3,$4,'{}',0,'{}','PREPARING',$5,100000)`,[fid,buyer,randomUUID(),qid,tx.id]);
    await db.query(`INSERT INTO fulfillment_order_items(fulfillment_id,inventory_item_id,prize,previous_lock) VALUES($1,$2,'{}',false)`,[fid,iid]);
    await db.query(`INSERT INTO warehouse_allocations(fulfillment_id,sku_id,quantity,state) VALUES($1,$2,1,'RESERVED')`,[fid,f.sku]);
    await db.query('UPDATE warehouse_skus SET on_hand=1,reserved=1 WHERE id=$1',[f.sku]);
    let r=await service.report(actor());expect(r.skus.find(s=>s.skuId===f.sku)).toMatchObject({available:'0',awardedAwaitingDispatch:'1',creditedShipmentReservations:'1',awardedShortfall:'0',allocationInconsistent:false});
    await db.query('UPDATE warehouse_skus SET reserved=0 WHERE id=$1',[f.sku]);
    r=await service.report(actor());expect(r.skus.find(s=>s.skuId===f.sku)!.allocationInconsistent).toBe(true);
  });
  it('rejects a revoked owner and stale session',async()=>{
    await expect(service.report({...actor(),authVersion:99})).rejects.toMatchObject({status:401});
    await db.query("UPDATE operations_permissions SET active=false WHERE user_id=$1 AND permission='OWNER'",[owner]);
    expect((await http(jwt.sign({sub:owner,av:0}))).status).toBe(403);
    await db.query("UPDATE operations_permissions SET active=true WHERE user_id=$1 AND permission='OWNER'",[owner]);
  });
  it('fails closed rather than returning a truncated inventory assessment',async()=>{
    await db.query("INSERT INTO items(name,fulfillment_type) SELECT 'synthetic-limit-'||g,'UNSPECIFIED' FROM generate_series(1,2001) g");
    await expect(service.report(actor())).rejects.toMatchObject({status:503});
  });
});
