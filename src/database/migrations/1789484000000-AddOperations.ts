import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddOperations1789484000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE operations_permissions (
      user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      permission varchar(16) NOT NULL CHECK(permission IN('CATALOG','FULFILLMENT')),
      active boolean NOT NULL DEFAULT true, PRIMARY KEY(user_id,permission)
    )`);
    await r.query(`CREATE TABLE operations_requests (
      actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      request_key uuid NOT NULL,permission varchar(16) NOT NULL,
      payload_hash varchar(64) NOT NULL,response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,request_key)
    )`);
    await r.query(`CREATE TABLE catalog_drafts (
      gacha_id integer PRIMARY KEY REFERENCES gachas(id) ON DELETE RESTRICT,
      version integer NOT NULL CHECK(version>0),config jsonb NOT NULL,
      dirty boolean NOT NULL DEFAULT true,published_version integer,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(`CREATE TABLE operations_events (
      id bigserial PRIMARY KEY,actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      target_type varchar(16) NOT NULL CHECK(target_type IN('CATALOG','FULFILLMENT')),
      target_id varchar(40) NOT NULL,event varchar(32) NOT NULL,detail jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(
      'CREATE INDEX operations_events_target ON operations_events(target_type,target_id,id DESC)',
    );
    await r.query(`ALTER TABLE fulfillment_orders ADD operations_version integer NOT NULL DEFAULT 1 CHECK(operations_version>0),
      ADD carrier varchar(16),ADD tracking_number varchar(40),ADD dispatched_at timestamptz,ADD delivered_at timestamptz`);
    await r.query(`ALTER TABLE fulfillment_orders ADD CONSTRAINT fulfillment_tracking_pair CHECK((carrier IS NULL AND tracking_number IS NULL) OR
      (carrier IN('CJ','HANJIN','LOTTE','POST','LOGEN','OTHER') AND tracking_number ~ '^[A-Za-z0-9-]{5,40}$'))`);
    await r.query(
      'CREATE INDEX fulfillment_status_created ON fulfillment_orders(status,created_at,id)',
    );
  }
  async down(r: QueryRunner): Promise<void> {
    const [row] = await r.query(
      `SELECT (SELECT count(*) FROM operations_events)+(SELECT count(*) FROM operations_requests)+(SELECT count(*) FROM catalog_drafts)+(SELECT count(*) FROM operations_permissions) AS n`,
    );
    if (Number(row.n)) throw new Error('Cannot remove operations history');
    await r.query('DROP INDEX fulfillment_status_created');
    await r.query(
      'ALTER TABLE fulfillment_orders DROP CONSTRAINT fulfillment_tracking_pair,DROP operations_version,DROP carrier,DROP tracking_number,DROP dispatched_at,DROP delivered_at',
    );
    await r.query(
      'DROP TABLE operations_events,catalog_drafts,operations_requests,operations_permissions',
    );
  }
}
