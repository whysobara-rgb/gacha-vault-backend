import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddAccountSupport1789483000000 implements MigrationInterface {
  async up(r: QueryRunner) {
    await r.query(
      `ALTER TABLE users ADD auth_version integer NOT NULL DEFAULT 0 CHECK(auth_version>=0), ADD password_check_failures integer NOT NULL DEFAULT 0, ADD password_locked_until timestamptz`,
    );
    await r.query(
      `CREATE TABLE account_security_events(id bigserial PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,event varchar(32) NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
    );
    await r.query(
      `CREATE TABLE account_closure_requests(id uuid PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,idempotency_key uuid NOT NULL,reason varchar(255) NOT NULL,status varchar(16) NOT NULL CHECK(status IN('REQUESTED','CANCELLED')),summary jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),cancelled_at timestamptz,UNIQUE(user_id,idempotency_key),CHECK((status='CANCELLED')=(cancelled_at IS NOT NULL)))`,
    );
    await r.query(
      `CREATE UNIQUE INDEX one_active_closure ON account_closure_requests(user_id) WHERE status='REQUESTED'`,
    );
    await r.query(
      `CREATE TABLE support_staff(user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
    );
    await r.query(
      `CREATE TABLE support_tickets(id uuid PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,idempotency_key uuid NOT NULL,request_hash varchar(64) NOT NULL,category varchar(16) NOT NULL CHECK(category IN('PAYMENT','REFUND','SHIPPING','ACCOUNT','OTHER')),subject varchar(100) NOT NULL,order_id uuid REFERENCES capsule_orders(id) ON DELETE RESTRICT,status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK(status IN('OPEN','ANSWERED','CLOSED')),version integer NOT NULL DEFAULT 1,last_sequence integer NOT NULL DEFAULT 1,last_staff_sequence integer NOT NULL DEFAULT 0,customer_read_sequence integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(user_id,idempotency_key),CHECK(customer_read_sequence<=last_sequence AND customer_read_sequence>=0),CHECK(last_staff_sequence<=last_sequence AND last_staff_sequence>=0))`,
    );
    await r.query(
      `CREATE TABLE support_messages(id uuid PRIMARY KEY,ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE RESTRICT,actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,actor_role varchar(16) NOT NULL CHECK(actor_role IN('CUSTOMER','SUPPORT')),idempotency_key uuid NOT NULL,sequence integer NOT NULL CHECK(sequence>=1),body varchar(4000) NOT NULL CHECK(length(body)>=1),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(ticket_id,sequence),UNIQUE(actor_id,idempotency_key))`,
    );
    await r.query(
      `CREATE TABLE support_events(id bigserial PRIMARY KEY,ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE RESTRICT,actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,event varchar(32) NOT NULL,version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
    );
    await r.query(
      'CREATE INDEX support_owner_history ON support_tickets(user_id,created_at DESC,id DESC)',
    );
    await r.query(
      'CREATE INDEX support_queue ON support_tickets(status,updated_at DESC,id DESC)',
    );
    await r.query(
      'CREATE INDEX support_actor_rate ON support_messages(actor_id,created_at DESC)',
    );
    await r.query(
      'CREATE INDEX closure_owner_history ON account_closure_requests(user_id,created_at DESC,id DESC)',
    );
  }
  async down(r: QueryRunner) {
    const [{ n }] = await r.query(
      `SELECT (SELECT count(*) FROM account_security_events)+(SELECT count(*) FROM support_tickets)+(SELECT count(*) FROM account_closure_requests)+(SELECT count(*) FROM support_staff) AS n`,
    );
    if (Number(n))
      throw new Error(
        'Account/support records require retention; automatic rollback refused',
      );
    await r.query(
      'DROP TABLE support_events,support_messages,support_tickets,support_staff,account_closure_requests,account_security_events',
    );
    await r.query(
      'ALTER TABLE users DROP auth_version,DROP password_check_failures,DROP password_locked_until',
    );
  }
}
