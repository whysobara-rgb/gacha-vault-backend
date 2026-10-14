import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInventoryConversions1789480000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(
      `ALTER TABLE inventory_items ALTER COLUMN status DROP DEFAULT`,
    );
    await r.query(
      `ALTER TABLE inventory_items ALTER COLUMN status TYPE varchar(32) USING status::text`,
    );
    await r.query(
      `ALTER TABLE inventory_items ALTER COLUMN status SET DEFAULT 'STORED'`,
    );
    await r.query(
      `ALTER TABLE inventory_items ADD CONSTRAINT inventory_status_v2 CHECK (status IN ('STORED','CONVERTED','SHIPPING_REQUESTED','SHIPPING','DELIVERED'))`,
    );
    await r.query(
      `ALTER TABLE users ADD gp_spend_version bigint NOT NULL DEFAULT 0 CHECK (gp_spend_version >= 0)`,
    );
    await r.query(
      `ALTER TABLE wallet_transactions ADD origin varchar(32) NOT NULL DEFAULT 'LEGACY'`,
    );
    // A later GP purchase invalidates restoration even if the balance is topped
    // back up. A restoration is a reversal, not another spending event.
    await r.query(`CREATE FUNCTION track_gp_spend() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.amount < 0 AND NEW.origin <> 'INVENTORY_RESTORE' THEN
        UPDATE users SET gp_spend_version = gp_spend_version + 1 WHERE id = NEW.user_id;
      END IF; RETURN NEW; END $$`);
    await r.query(
      `CREATE TRIGGER track_gp_spend AFTER INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION track_gp_spend()`,
    );
    await r.query(`CREATE TABLE inventory_conversions (
      id uuid PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      idempotency_key uuid NOT NULL, request_hash varchar(64) NOT NULL,
      total_gp integer NOT NULL CHECK (total_gp > 0), balance_after bigint NOT NULL CHECK (balance_after >= 0),
      spend_version bigint NOT NULL CHECK (spend_version >= 0), policy jsonb NOT NULL,
      status varchar(16) NOT NULL CHECK (status IN ('CONVERTED','RESTORED')),
      wallet_transaction_id integer NOT NULL UNIQUE REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
      restore_wallet_transaction_id integer UNIQUE REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
      restored_balance_after bigint, restore_until timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), restored_at timestamptz,
      UNIQUE(user_id, idempotency_key),
      CHECK ((status = 'CONVERTED' AND restored_at IS NULL AND restore_wallet_transaction_id IS NULL AND restored_balance_after IS NULL) OR
        (status = 'RESTORED' AND restored_at IS NOT NULL AND restore_wallet_transaction_id IS NOT NULL AND restored_balance_after >= 0))
    )`);
    await r.query(`CREATE TABLE inventory_conversion_items (
      conversion_id uuid NOT NULL REFERENCES inventory_conversions(id) ON DELETE RESTRICT,
      inventory_item_id integer NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      prize jsonb NOT NULL, amount_gp integer NOT NULL CHECK (amount_gp > 0),
      PRIMARY KEY(conversion_id, inventory_item_id)
    )`);
    await r.query(
      `CREATE INDEX conversions_owner_created ON inventory_conversions(user_id, created_at DESC, id DESC)`,
    );
    await r.query(
      `CREATE INDEX conversion_items_inventory ON inventory_conversion_items(inventory_item_id)`,
    );
  }
  async down(r: QueryRunner): Promise<void> {
    const [{ n }] = await r.query(
      `SELECT count(*) AS n FROM inventory_conversions`,
    );
    if (Number(n)) throw new Error('Cannot remove conversion history');
    await r.query('DROP TABLE inventory_conversion_items');
    await r.query('DROP TABLE inventory_conversions');
    await r.query('DROP TRIGGER track_gp_spend ON wallet_transactions');
    await r.query('DROP FUNCTION track_gp_spend()');
    await r.query('ALTER TABLE wallet_transactions DROP COLUMN origin');
    await r.query('ALTER TABLE users DROP COLUMN gp_spend_version');
    await r.query(
      'ALTER TABLE inventory_items DROP CONSTRAINT inventory_status_v2',
    );
    await r.query(
      'ALTER TABLE inventory_items ALTER COLUMN status DROP DEFAULT',
    );
    await r.query(
      'ALTER TABLE inventory_items ALTER COLUMN status TYPE inventory_items_status_enum USING status::inventory_items_status_enum',
    );
    await r.query(
      "ALTER TABLE inventory_items ALTER COLUMN status SET DEFAULT 'STORED'",
    );
  }
}
