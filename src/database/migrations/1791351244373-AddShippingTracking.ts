import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShippingTracking1791351244373 implements MigrationInterface {
  name = 'AddShippingTracking1791351244373';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "shipping_requests" ADD "trackingCompany" character varying(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "shipping_requests" ADD "trackingNumber" character varying(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "shipping_requests" ADD "shippedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "shipping_requests" ADD "deliveredAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "shipping_requests" DROP COLUMN "deliveredAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "shipping_requests" DROP COLUMN "shippedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "shipping_requests" DROP COLUMN "trackingNumber"`,
    );
    await queryRunner.query(
      `ALTER TABLE "shipping_requests" DROP COLUMN "trackingCompany"`,
    );
  }
}
