import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddWarehouseNotifications1789485000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(
      `ALTER TABLE operations_permissions DROP CONSTRAINT operations_permissions_permission_check, ADD CHECK(permission IN('CATALOG','FULFILLMENT','WAREHOUSE','ANNOUNCEMENTS'))`,
    );
    await r.query(
      `ALTER TABLE operations_events DROP CONSTRAINT operations_events_target_type_check,ADD CHECK(target_type IN('CATALOG','FULFILLMENT','WAREHOUSE','ANNOUNCEMENTS'))`,
    );
    await r.query(`CREATE TABLE warehouse_skus(id serial PRIMARY KEY,code varchar(40) NOT NULL UNIQUE,name varchar(255) NOT NULL,
      on_hand integer NOT NULL DEFAULT 0 CHECK(on_hand BETWEEN 0 AND 10000000),reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=on_hand),
      reorder_point integer NOT NULL DEFAULT 0 CHECK(reorder_point BETWEEN 0 AND 10000000),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now())`);
    await r.query(
      `ALTER TABLE items ADD warehouse_sku_id integer REFERENCES warehouse_skus(id) ON DELETE RESTRICT,ADD warehouse_link_version integer NOT NULL DEFAULT 0 CHECK(warehouse_link_version>=0)`,
    );
    await r.query(`CREATE TABLE warehouse_allocations(fulfillment_id uuid NOT NULL REFERENCES fulfillment_orders(id) ON DELETE RESTRICT,
      sku_id integer NOT NULL REFERENCES warehouse_skus(id) ON DELETE RESTRICT,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),
      state varchar(12) NOT NULL CHECK(state IN('RESERVED','RELEASED','CONSUMED')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(fulfillment_id,sku_id))`);
    await r.query(`CREATE TABLE warehouse_movements(id bigserial PRIMARY KEY,sku_id integer NOT NULL REFERENCES warehouse_skus(id) ON DELETE RESTRICT,
      actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,kind varchar(16) NOT NULL CHECK(kind IN('RECEIVE','ADJUST','RESERVE','RELEASE','DISPATCH')),
      source_key varchar(100) NOT NULL,delta_on_hand integer NOT NULL,delta_reserved integer NOT NULL,on_hand_after integer NOT NULL,reserved_after integer NOT NULL,
      reason varchar(255) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(sku_id,source_key),CHECK(on_hand_after>=0 AND reserved_after>=0 AND reserved_after<=on_hand_after))`);
    await r.query(
      'CREATE INDEX warehouse_movement_sku ON warehouse_movements(sku_id,id DESC)',
    );
    await r.query(`CREATE TABLE app_notifications(id bigserial PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      source_key varchar(120) NOT NULL,kind varchar(24) NOT NULL CHECK(kind IN('SHIPMENT_UPDATE','SUPPORT_REPLY')),title varchar(120) NOT NULL,body varchar(400) NOT NULL,
      target_id uuid NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,source_key))`);
    await r.query(
      'CREATE INDEX notifications_owner ON app_notifications(user_id,id DESC)',
    );
    await r.query(`CREATE TABLE announcements(id uuid PRIMARY KEY,title varchar(120) NOT NULL,body text NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),
      category varchar(16) NOT NULL CHECK(category IN('NOTICE','MAINTENANCE')),status varchar(12) NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','PUBLISHED','ARCHIVED')),
      version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now())`);
    await r.query(
      `CREATE TABLE announcement_reads(user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE RESTRICT,read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,announcement_id))`,
    );
  }
  async down(r: QueryRunner): Promise<void> {
    const [{ n }] = await r.query(
      `SELECT (SELECT count(*) FROM warehouse_skus)+(SELECT count(*) FROM app_notifications)+(SELECT count(*) FROM announcements)+(SELECT count(*) FROM operations_permissions WHERE permission IN('WAREHOUSE','ANNOUNCEMENTS')) AS n`,
    );
    if (Number(n))
      throw new Error('Cannot remove warehouse or notification records');
    await r.query(
      'DROP TABLE announcement_reads,announcements,app_notifications,warehouse_movements,warehouse_allocations',
    );
    await r.query(
      'ALTER TABLE items DROP warehouse_sku_id,DROP warehouse_link_version',
    );
    await r.query('DROP TABLE warehouse_skus');
    await r.query(
      `ALTER TABLE operations_permissions DROP CONSTRAINT operations_permissions_permission_check,ADD CHECK(permission IN('CATALOG','FULFILLMENT'))`,
    );
    await r.query(
      `ALTER TABLE operations_events DROP CONSTRAINT operations_events_target_type_check,ADD CHECK(target_type IN('CATALOG','FULFILLMENT'))`,
    );
  }
}
