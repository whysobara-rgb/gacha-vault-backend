import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGachaEngineFeatures1791346320746 implements MigrationInterface {
  name = 'AddGachaEngineFeatures1791346320746';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "gacha_pity_counters" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "gacha_id" integer NOT NULL, "drawsSinceTopTier" integer NOT NULL DEFAULT '0', "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_15fe2b8844c67a268f274eebed6" UNIQUE ("user_id", "gacha_id"), CONSTRAINT "PK_b1cfe2b3ccdfc74beb6162fdf6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "attendance_checkins" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "checkinDate" date NOT NULL, "streakDay" integer NOT NULL, "reward" integer NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_62653ff61491beaaf659499ae1c" UNIQUE ("user_id", "checkinDate"), CONSTRAINT "PK_c652f34afe99bdbab2735975729" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`ALTER TABLE "gachas" ADD "pityThreshold" integer`);
    await queryRunner.query(
      `ALTER TABLE "draws" ADD "isPity" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "draws" ADD "isBonus" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "monthlyTopupLimit" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "pendingMonthlyTopupLimit" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "pendingTopupLimitEffectiveAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."wallet_transactions_reason_enum" AS ENUM('TOPUP', 'SIGNUP_BONUS', 'ATTENDANCE', 'EXCHANGE', 'DRAW', 'SHIPPING_FEE', 'ADJUSTMENT')`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" ADD "reason" "public"."wallet_transactions_reason_enum"`,
    );
    // Backfill reasons for rows written before the column existed, from the
    // fixed descriptions each writer used. Monthly top-up limits sum TOPUP.
    await queryRunner.query(`UPDATE "wallet_transactions" SET "reason" = (CASE
            WHEN "description" = 'GP 충전' THEN 'TOPUP'
            WHEN "description" = '회원가입 축하 GP' THEN 'SIGNUP_BONUS'
            WHEN "description" = '배송 신청 배송비' THEN 'SHIPPING_FEE'
            WHEN "description" LIKE 'GP 충전 (seed%' THEN 'ADJUSTMENT'
            WHEN "type" = 'USE' AND "description" LIKE '% 뽑기%' THEN 'DRAW'
        END)::"public"."wallet_transactions_reason_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."inventory_items_status_enum" RENAME TO "inventory_items_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."inventory_items_status_enum" AS ENUM('STORED', 'SHIPPING_REQUESTED', 'SHIPPING', 'DELIVERED', 'EXCHANGED')`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ALTER COLUMN "status" TYPE "public"."inventory_items_status_enum" USING "status"::"text"::"public"."inventory_items_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ALTER COLUMN "status" SET DEFAULT 'STORED'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."inventory_items_status_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gacha_pity_counters" ADD CONSTRAINT "FK_e3b0f90f4743c51df21bd5d501a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "gacha_pity_counters" ADD CONSTRAINT "FK_2aa3a41a4afb177671bf4e1b7e9" FOREIGN KEY ("gacha_id") REFERENCES "gachas"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attendance_checkins" ADD CONSTRAINT "FK_d27c110640c64b373a9e60fba9e" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Fails on purpose if any item was already EXCHANGED: those items were
    // paid out as GP and must not silently become shippable again.
    await queryRunner.query(
      `ALTER TABLE "attendance_checkins" DROP CONSTRAINT "FK_d27c110640c64b373a9e60fba9e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gacha_pity_counters" DROP CONSTRAINT "FK_2aa3a41a4afb177671bf4e1b7e9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gacha_pity_counters" DROP CONSTRAINT "FK_e3b0f90f4743c51df21bd5d501a"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."inventory_items_status_enum_old" AS ENUM('STORED', 'SHIPPING_REQUESTED', 'SHIPPING', 'DELIVERED')`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ALTER COLUMN "status" TYPE "public"."inventory_items_status_enum_old" USING "status"::"text"::"public"."inventory_items_status_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ALTER COLUMN "status" SET DEFAULT 'STORED'`,
    );
    await queryRunner.query(`DROP TYPE "public"."inventory_items_status_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."inventory_items_status_enum_old" RENAME TO "inventory_items_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" DROP COLUMN "reason"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."wallet_transactions_reason_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "pendingTopupLimitEffectiveAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "pendingMonthlyTopupLimit"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "monthlyTopupLimit"`,
    );
    await queryRunner.query(`ALTER TABLE "draws" DROP COLUMN "isBonus"`);
    await queryRunner.query(`ALTER TABLE "draws" DROP COLUMN "isPity"`);
    await queryRunner.query(`ALTER TABLE "gachas" DROP COLUMN "pityThreshold"`);
    await queryRunner.query(`DROP TABLE "attendance_checkins"`);
    await queryRunner.query(`DROP TABLE "gacha_pity_counters"`);
  }
}
