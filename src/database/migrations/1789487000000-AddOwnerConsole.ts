import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddOwnerConsole1789487000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(`ALTER TABLE operations_permissions DROP CONSTRAINT operations_permissions_permission_check,
      ADD CHECK(permission IN('CATALOG','FULFILLMENT','WAREHOUSE','ANNOUNCEMENTS','OWNER'))`);
    await r.query(`ALTER TABLE operations_events DROP CONSTRAINT operations_events_target_type_check,
      ADD CHECK(target_type IN('CATALOG','FULFILLMENT','WAREHOUSE','ANNOUNCEMENTS','OWNER'))`);
    await r.query(`CREATE TABLE supplier_orders (
      id uuid PRIMARY KEY,sku_id integer NOT NULL REFERENCES warehouse_skus(id) ON DELETE RESTRICT,
      supplier varchar(120) NOT NULL,reference varchar(120) NOT NULL DEFAULT '',
      quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),received integer NOT NULL DEFAULT 0,
      unit_cost_krw integer NOT NULL CHECK(unit_cost_krw BETWEEN 0 AND 100000000),
      expected_at timestamptz NOT NULL,status varchar(12) NOT NULL DEFAULT 'PLANNED'
      CHECK(status IN('PLANNED','ORDERED','PARTIAL','RECEIVED','CANCELLED')),
      version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),CHECK(received>=0 AND received<=quantity),
      CHECK((status='RECEIVED')=(received=quantity)),CHECK(status NOT IN('PLANNED','ORDERED','CANCELLED') OR received=0))`);
    await r.query(
      'CREATE INDEX supplier_orders_work ON supplier_orders(status,expected_at,id)',
    );
    await r.query(`CREATE TABLE owner_campaigns (
      id uuid PRIMARY KEY,title varchar(120) NOT NULL,body varchar(3000) NOT NULL,
      kind varchar(12) NOT NULL CHECK(kind IN('SHOWCASE','NOTICE')),
      gacha_id integer REFERENCES gachas(id) ON DELETE RESTRICT,
      starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
      budget_krw integer NOT NULL CHECK(budget_krw BETWEEN 0 AND 100000000),
      status varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','PUBLISHED','PAUSED','ARCHIVED')),
      version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),CHECK((kind='SHOWCASE')=(gacha_id IS NOT NULL)))`);
    await r.query(
      'CREATE INDEX owner_campaigns_public ON owner_campaigns(status,starts_at,ends_at,id)',
    );
  }
  async down(r: QueryRunner): Promise<void> {
    const [{ n }] =
      await r.query(`SELECT (SELECT count(*) FROM supplier_orders)+(SELECT count(*) FROM owner_campaigns)+
      (SELECT count(*) FROM operations_permissions WHERE permission='OWNER')+(SELECT count(*) FROM operations_events WHERE target_type='OWNER') AS n`);
    if (Number(n))
      throw new Error('Owner records require an explicit retention migration');
    await r.query('DROP TABLE owner_campaigns,supplier_orders');
    await r.query(
      `ALTER TABLE operations_permissions DROP CONSTRAINT operations_permissions_permission_check,ADD CHECK(permission IN('CATALOG','FULFILLMENT','WAREHOUSE','ANNOUNCEMENTS'))`,
    );
    await r.query(
      `ALTER TABLE operations_events DROP CONSTRAINT operations_events_target_type_check,ADD CHECK(target_type IN('CATALOG','FULFILLMENT','WAREHOUSE','ANNOUNCEMENTS'))`,
    );
  }
}
