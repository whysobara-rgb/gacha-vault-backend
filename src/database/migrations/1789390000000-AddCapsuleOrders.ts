import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCapsuleOrders1789390000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE capsule_orders (
      id uuid PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      idempotency_key uuid NOT NULL,
      gacha_id integer NOT NULL REFERENCES gachas(id) ON DELETE RESTRICT,
      title_snapshot varchar(255) NOT NULL,
      unit_price integer NOT NULL CHECK (unit_price > 0),
      quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
      total integer NOT NULL CHECK (total > 0 AND total::bigint = unit_price::bigint * quantity),
      currency varchar(16) NOT NULL CHECK (currency = 'GP'),
      status varchar(24) NOT NULL CHECK (status = 'PAID'),
      wallet_transaction_id integer NOT NULL UNIQUE REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
      balance_after bigint NOT NULL CHECK (balance_after >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, idempotency_key)
    )`);
    await runner.query(
      'CREATE INDEX capsule_orders_gacha_idx ON capsule_orders(gacha_id)',
    );
    await runner.query(`CREATE TABLE owned_capsules (
      id uuid PRIMARY KEY,
      order_id uuid NOT NULL REFERENCES capsule_orders(id) ON DELETE RESTRICT,
      sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 100),
      status varchar(24) NOT NULL DEFAULT 'UNOPENED' CHECK (status = 'UNOPENED'),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (order_id, sequence)
    )`);
    await runner.query(
      'CREATE INDEX owned_capsules_order_idx ON owned_capsules(order_id)',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    // Never silently erase paid order history during rollback.
    const [{ count }] = await runner.query(
      'SELECT count(*) FROM capsule_orders',
    );
    if (Number(count) !== 0)
      throw new Error('Cannot revert capsule schema containing orders');
    await runner.query('DROP TABLE owned_capsules');
    await runner.query('DROP TABLE capsule_orders');
  }
}
