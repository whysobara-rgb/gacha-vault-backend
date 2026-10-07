import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPaymentOrders1791350980419 implements MigrationInterface {
  name = 'AddPaymentOrders1791350980419';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."payment_orders_status_enum" AS ENUM('READY', 'IN_PROGRESS', 'DONE', 'FAILED', 'CANCELED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payment_orders" ("id" SERIAL NOT NULL, "orderId" character varying(64) NOT NULL, "user_id" integer NOT NULL, "packageId" character varying(30) NOT NULL, "amount" integer NOT NULL, "gp" integer NOT NULL, "bonusGp" integer NOT NULL DEFAULT '0', "firstTopupBonusGp" integer NOT NULL DEFAULT '0', "status" "public"."payment_orders_status_enum" NOT NULL DEFAULT 'READY', "paymentKey" character varying(200), "method" character varying(50), "failureReason" character varying(500), "approvedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_158dd178010c39759305293a149" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_7257f2ae6d4b6dde613278884f" ON "payment_orders" ("orderId") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_6d11dad9db327a7a61b3039bbb" ON "payment_orders" ("paymentKey") `,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."wallet_transactions_reason_enum" RENAME TO "wallet_transactions_reason_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."wallet_transactions_reason_enum" AS ENUM('TOPUP', 'BONUS', 'SIGNUP_BONUS', 'ATTENDANCE', 'EXCHANGE', 'DRAW', 'SHIPPING_FEE', 'ADJUSTMENT')`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" ALTER COLUMN "reason" TYPE "public"."wallet_transactions_reason_enum" USING "reason"::"text"::"public"."wallet_transactions_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."wallet_transactions_reason_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_orders" ADD CONSTRAINT "FK_67a9a9eb3fcc40dd54a339f8788" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_orders" DROP CONSTRAINT "FK_67a9a9eb3fcc40dd54a339f8788"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."wallet_transactions_reason_enum_old" AS ENUM('TOPUP', 'SIGNUP_BONUS', 'ATTENDANCE', 'EXCHANGE', 'DRAW', 'SHIPPING_FEE', 'ADJUSTMENT')`,
    );
    await queryRunner.query(
      `ALTER TABLE "wallet_transactions" ALTER COLUMN "reason" TYPE "public"."wallet_transactions_reason_enum_old" USING "reason"::"text"::"public"."wallet_transactions_reason_enum_old"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."wallet_transactions_reason_enum"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."wallet_transactions_reason_enum_old" RENAME TO "wallet_transactions_reason_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6d11dad9db327a7a61b3039bbb"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7257f2ae6d4b6dde613278884f"`,
    );
    await queryRunner.query(`DROP TABLE "payment_orders"`);
    await queryRunner.query(`DROP TYPE "public"."payment_orders_status_enum"`);
  }
}
