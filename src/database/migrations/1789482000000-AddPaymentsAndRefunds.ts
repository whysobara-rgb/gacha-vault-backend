import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddPaymentsAndRefunds1789482000000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(
      `ALTER TABLE gachas ADD sale_type varchar(16) NOT NULL DEFAULT 'UNSPECIFIED' CHECK(sale_type IN('STANDARD','EVENT','UNSPECIFIED')), ADD cash_enabled boolean NOT NULL DEFAULT false, ADD cash_unit_price integer CHECK(cash_unit_price>=100), ADD CONSTRAINT cash_price_required CHECK(NOT cash_enabled OR cash_unit_price IS NOT NULL)`,
    );
    await r.query(
      `ALTER TABLE capsule_orders DROP CONSTRAINT capsule_orders_status_check, DROP CONSTRAINT capsule_orders_currency_check, ALTER COLUMN wallet_transaction_id DROP NOT NULL, ADD refunded_quantity integer NOT NULL DEFAULT 0 CHECK(refunded_quantity>=0 AND refunded_quantity<=quantity), ADD refund_eligible boolean NOT NULL DEFAULT false, ADD refund_until timestamptz, ADD refund_policy jsonb, ADD CONSTRAINT capsule_orders_status_check CHECK(status IN('PAID','PARTIALLY_REFUNDED','REFUNDED')), ADD CONSTRAINT capsule_orders_currency_check CHECK(currency IN('GP','KRW')), ADD CONSTRAINT order_wallet_currency CHECK((currency='GP' AND wallet_transaction_id IS NOT NULL) OR (currency='KRW' AND wallet_transaction_id IS NULL))`,
    );
    await r.query(
      `ALTER TABLE owned_capsules DROP CONSTRAINT owned_capsules_status_check, ADD CONSTRAINT owned_capsules_status_check CHECK(status IN('UNOPENED','OPENED','REFUND_PENDING','REFUNDED'))`,
    );
    await r.query(
      `CREATE TABLE payment_intents(id uuid PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id),idempotency_key uuid NOT NULL,gacha_id integer NOT NULL REFERENCES gachas(id),title varchar(255) NOT NULL,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),unit_price integer NOT NULL CHECK(unit_price>=100),amount integer NOT NULL CHECK(amount::bigint=quantity::bigint*unit_price),currency varchar(3) NOT NULL DEFAULT 'KRW' CHECK(currency='KRW'),probability_snapshot jsonb NOT NULL,probability_version varchar(64) NOT NULL,sale_type varchar(16) NOT NULL,refund_calendar jsonb,status varchar(24) NOT NULL CHECK(status IN('PREPARED','AUTHENTICATED','CONFIRMING','UNKNOWN','APPROVED','PAID','CANCELLED')),transaction_id varchar(32) UNIQUE,merchant_id varchar(20) NOT NULL,method varchar(16) NOT NULL DEFAULT 'CARD' CHECK(method='CARD'),provider_receipt jsonb,order_id uuid UNIQUE REFERENCES capsule_orders(id),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,idempotency_key),CHECK((status='PAID')=(order_id IS NOT NULL)))`,
    );
    await r.query(
      `CREATE TABLE order_refunds(id uuid PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id),order_id uuid NOT NULL REFERENCES capsule_orders(id),idempotency_key uuid NOT NULL,request_hash varchar(64) NOT NULL,capsule_ids uuid[] NOT NULL CHECK(cardinality(capsule_ids) BETWEEN 1 AND 100),amount integer NOT NULL CHECK(amount>0),currency varchar(3) NOT NULL CHECK(currency IN('GP','KRW')),status varchar(24) NOT NULL CHECK(status IN('PROCESSING','UNKNOWN','APPROVED','SUCCEEDED')),wallet_transaction_id integer UNIQUE REFERENCES wallet_transactions(id),provider_cancel_id varchar(32) UNIQUE,balance_after bigint,reason varchar(255) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(user_id,idempotency_key),CHECK((status='SUCCEEDED')=(completed_at IS NOT NULL)))`,
    );
    await r.query(
      `CREATE TABLE payment_prize_refs(payment_id uuid NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,item_id integer NOT NULL REFERENCES items(id) ON DELETE RESTRICT,PRIMARY KEY(payment_id,item_id))`,
    );
    await r.query(
      "CREATE UNIQUE INDEX order_refund_inflight ON order_refunds(order_id) WHERE status<>'SUCCEEDED'",
    );
    await r.query(
      'CREATE INDEX payment_reservations ON payment_intents(gacha_id,status,expires_at)',
    );
    await r.query(
      'CREATE INDEX payment_owner_history ON payment_intents(user_id,created_at DESC,id DESC)',
    );
    await r.query(
      'CREATE INDEX refund_owner_history ON order_refunds(user_id,created_at DESC,id DESC)',
    );
  }
  async down(r: QueryRunner) {
    const [{ n }] = await r.query(
      'SELECT (SELECT count(*) FROM payment_intents)+(SELECT count(*) FROM order_refunds)+(SELECT count(*) FROM capsule_orders WHERE refund_policy IS NOT NULL) AS n',
    );
    if (Number(n)) throw new Error('Cannot remove payment/refund history');
    await r.query('DROP TABLE order_refunds');
    await r.query('DROP TABLE payment_prize_refs');
    await r.query('DROP TABLE payment_intents');
    await r.query(
      `ALTER TABLE owned_capsules DROP CONSTRAINT owned_capsules_status_check,ADD CONSTRAINT owned_capsules_status_check CHECK(status IN('UNOPENED','OPENED'))`,
    );
    await r.query(
      `ALTER TABLE capsule_orders DROP CONSTRAINT order_wallet_currency,DROP CONSTRAINT capsule_orders_status_check,DROP CONSTRAINT capsule_orders_currency_check,DROP refunded_quantity,DROP refund_eligible,DROP refund_until,DROP refund_policy,ALTER wallet_transaction_id SET NOT NULL,ADD CONSTRAINT capsule_orders_status_check CHECK(status='PAID'),ADD CONSTRAINT capsule_orders_currency_check CHECK(currency='GP')`,
    );
    await r.query(
      'ALTER TABLE gachas DROP CONSTRAINT cash_price_required,DROP cash_enabled,DROP cash_unit_price,DROP sale_type',
    );
  }
}
