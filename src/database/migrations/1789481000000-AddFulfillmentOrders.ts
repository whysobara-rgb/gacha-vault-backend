import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddFulfillmentOrders1789481000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(
      `ALTER TABLE items ADD fulfillment_type varchar(16) NOT NULL DEFAULT 'UNSPECIFIED' CHECK (fulfillment_type IN ('PHYSICAL','DIGITAL','MANUAL','UNSPECIFIED')), ADD shipping_enabled boolean NOT NULL DEFAULT false`,
    );
    await r.query(`CREATE TABLE fulfillment_quotes (
      id uuid PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      inventory_item_ids integer[] NOT NULL CHECK (cardinality(inventory_item_ids) BETWEEN 1 AND 100),
      recipient jsonb NOT NULL,items jsonb NOT NULL,fee_gp integer NOT NULL CHECK (fee_gp>=0),
      rate_version varchar(64) NOT NULL,zone jsonb NOT NULL,expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(`CREATE TABLE fulfillment_orders (
      id uuid PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      idempotency_key uuid NOT NULL,quote_id uuid NOT NULL UNIQUE REFERENCES fulfillment_quotes(id) ON DELETE RESTRICT,
      recipient jsonb NOT NULL,fee_gp integer NOT NULL CHECK(fee_gp>=0),zone jsonb NOT NULL,
      status varchar(16) NOT NULL CHECK(status IN('REQUESTED','PREPARING','COLLECTED','SHIPPING','DELIVERED','CANCELLED')),
      wallet_transaction_id integer NOT NULL UNIQUE REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
      balance_after bigint NOT NULL CHECK(balance_after>=0),
      cancel_wallet_transaction_id integer UNIQUE REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
      cancelled_balance_after bigint,created_at timestamptz NOT NULL DEFAULT now(),cancelled_at timestamptz,
      UNIQUE(user_id,idempotency_key),
      CHECK((status='CANCELLED' AND cancel_wallet_transaction_id IS NOT NULL AND cancelled_balance_after IS NOT NULL AND cancelled_balance_after>=0 AND cancelled_at IS NOT NULL) OR
        (status<>'CANCELLED' AND cancel_wallet_transaction_id IS NULL AND cancelled_balance_after IS NULL AND cancelled_at IS NULL))
    )`);
    await r.query(`CREATE TABLE fulfillment_order_items (
      fulfillment_id uuid NOT NULL REFERENCES fulfillment_orders(id) ON DELETE RESTRICT,
      inventory_item_id integer NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      prize jsonb NOT NULL,previous_lock boolean NOT NULL,active boolean NOT NULL DEFAULT true,
      PRIMARY KEY(fulfillment_id,inventory_item_id)
    )`);
    await r.query(
      'CREATE UNIQUE INDEX fulfillment_active_inventory ON fulfillment_order_items(inventory_item_id) WHERE active',
    );
    await r.query(
      'CREATE INDEX fulfillment_owner_created ON fulfillment_orders(user_id,created_at DESC,id DESC)',
    );
    await r.query(
      'CREATE INDEX fulfillment_quote_owner_expiry ON fulfillment_quotes(user_id,expires_at)',
    );
  }
  async down(r: QueryRunner): Promise<void> {
    const [{ n }] = await r.query(
      'SELECT count(*) AS n FROM fulfillment_orders',
    );
    if (Number(n)) throw new Error('Cannot remove fulfillment history');
    await r.query('DROP TABLE fulfillment_order_items');
    await r.query('DROP TABLE fulfillment_orders');
    await r.query('DROP TABLE fulfillment_quotes');
    await r.query(
      'ALTER TABLE items DROP COLUMN fulfillment_type,DROP COLUMN shipping_enabled',
    );
  }
}
