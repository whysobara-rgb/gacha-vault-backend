import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddOwnerTraceAndPublishing1789488000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(
      "ALTER TABLE gachas ADD category varchar(16) NOT NULL DEFAULT 'other' CHECK(category IN('tech','home','luxury','fashion','food','other'))",
    );
    await r.query(
      'ALTER TABLE owner_campaigns ADD image_url text,ADD home_visible boolean NOT NULL DEFAULT false,ADD sort_order integer NOT NULL DEFAULT 50 CHECK(sort_order BETWEEN 0 AND 999)',
    );
    await r.query(`CREATE TABLE owner_cases(id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES capsule_orders(id) ON DELETE RESTRICT,
   ticket_id uuid REFERENCES support_tickets(id) ON DELETE RESTRICT,kind varchar(16) NOT NULL CHECK(kind IN('RETURN','EXCHANGE','MISSING','DAMAGE','OTHER')),
   status varchar(20) NOT NULL CHECK(status IN('OPEN','IN_PROGRESS','WAITING_EXTERNAL','CLOSED')),
   summary varchar(1000) NOT NULL,internal_note varchar(2000) NOT NULL DEFAULT '',external_reference varchar(200) NOT NULL DEFAULT '',
   version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
    await r.query(
      'CREATE INDEX owner_cases_order ON owner_cases(order_id,created_at,id)',
    );
    await r.query(
      'CREATE INDEX owner_cases_queue ON owner_cases(status,updated_at,id)',
    );
  }
  async down(r: QueryRunner): Promise<void> {
    const [{ n }] = await r.query(
      "SELECT (SELECT count(*) FROM owner_cases)+(SELECT count(*) FROM owner_campaigns WHERE home_visible OR image_url IS NOT NULL)+(SELECT count(*) FROM gachas WHERE category<>'other') AS n",
    );
    if (Number(n))
      throw new Error(
        'Owner publishing and case records require a retention migration',
      );
    await r.query('DROP TABLE owner_cases');
    await r.query(
      'ALTER TABLE owner_campaigns DROP image_url,DROP home_visible,DROP sort_order',
    );
    await r.query('ALTER TABLE gachas DROP category');
  }
}
