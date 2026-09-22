import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddCapsuleOpening1789391000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(
      `CREATE TABLE order_prize_refs (order_id uuid NOT NULL REFERENCES capsule_orders(id) ON DELETE CASCADE, item_id integer NOT NULL REFERENCES items(id) ON DELETE RESTRICT, PRIMARY KEY (order_id, item_id))`,
    );
    await r.query(
      'ALTER TABLE items ADD "isPremium" boolean, ADD "conversionGP" integer CHECK ("conversionGP" >= 0)',
    );
    await r.query(
      'ALTER TABLE gacha_items ADD "probabilityPpm" integer CHECK ("probabilityPpm" BETWEEN 1 AND 1000000)',
    );
    await r.query(
      `ALTER TABLE capsule_orders ADD probability_snapshot jsonb, ADD probability_version varchar(64), ADD CONSTRAINT order_probability_pair CHECK ((probability_snapshot IS NULL AND probability_version IS NULL) OR (probability_snapshot IS NOT NULL AND probability_version IS NOT NULL AND probability_version ~ '^[a-f0-9]{64}$'))`,
    );
    await r.query(
      `CREATE FUNCTION immutable_order_probability() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.probability_snapshot IS DISTINCT FROM OLD.probability_snapshot OR NEW.probability_version IS DISTINCT FROM OLD.probability_version THEN RAISE EXCEPTION 'Order probability is immutable'; END IF; RETURN NEW; END $$`,
    );
    await r.query(
      'CREATE TRIGGER immutable_order_probability BEFORE UPDATE ON capsule_orders FOR EACH ROW EXECUTE FUNCTION immutable_order_probability()',
    );
    await r.query(
      'ALTER TABLE owned_capsules DROP CONSTRAINT owned_capsules_status_check',
    );
    await r.query(
      "ALTER TABLE owned_capsules ADD CONSTRAINT owned_capsules_status_check CHECK (status IN ('UNOPENED', 'OPENED'))",
    );
    await r.query(`CREATE TABLE capsule_openings (
      capsule_id uuid PRIMARY KEY REFERENCES owned_capsules(id) ON DELETE RESTRICT,
      inventory_item_id integer NOT NULL UNIQUE REFERENCES inventory_items(id) ON DELETE RESTRICT,
      probability_version varchar(64) NOT NULL CHECK (probability_version ~ '^[a-f0-9]{64}$'),
      prize jsonb NOT NULL,
      ticket integer NOT NULL CHECK (ticket >= 0 AND ticket < 1000000),
      opened_at timestamptz NOT NULL DEFAULT now()
    )`);
    await r.query(
      `CREATE FUNCTION immutable_capsule_opening() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Capsule opening is immutable'; END $$`,
    );
    await r.query(
      'CREATE TRIGGER immutable_capsule_opening BEFORE UPDATE ON capsule_openings FOR EACH ROW EXECUTE FUNCTION immutable_capsule_opening()',
    );
  }
  async down(r: QueryRunner): Promise<void> {
    const [{ count }] = await r.query(
      'SELECT count(*) FROM capsule_orders WHERE probability_snapshot IS NOT NULL',
    );
    const [{ opened }] = await r.query(
      "SELECT count(*) AS opened FROM owned_capsules WHERE status = 'OPENED'",
    );
    const [{ results }] = await r.query(
      'SELECT count(*) AS results FROM capsule_openings',
    );
    if (Number(count) || Number(opened) || Number(results))
      throw new Error('Cannot revert probability/opening history');
    await r.query('DROP TABLE capsule_openings');
    await r.query('DROP TABLE order_prize_refs');
    await r.query('DROP FUNCTION immutable_capsule_opening()');
    await r.query('DROP TRIGGER immutable_order_probability ON capsule_orders');
    await r.query('DROP FUNCTION immutable_order_probability()');
    await r.query(
      'ALTER TABLE owned_capsules DROP CONSTRAINT owned_capsules_status_check',
    );
    await r.query(
      "ALTER TABLE owned_capsules ADD CONSTRAINT owned_capsules_status_check CHECK (status = 'UNOPENED')",
    );
    await r.query(
      'ALTER TABLE capsule_orders DROP CONSTRAINT order_probability_pair, DROP COLUMN probability_snapshot, DROP COLUMN probability_version',
    );
    await r.query('ALTER TABLE gacha_items DROP COLUMN "probabilityPpm"');
    await r.query(
      'ALTER TABLE items DROP COLUMN "isPremium", DROP COLUMN "conversionGP"',
    );
  }
}
