import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddImageAndStockToGachas1787233884024
  implements MigrationInterface
{
  name = 'AddImageAndStockToGachas1787233884024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gachas" ADD "imageUrl" character varying(500)`,
    );
    await queryRunner.query(
      `ALTER TABLE "gachas" ADD "totalStock" integer NOT NULL DEFAULT 10000`,
    );
    await queryRunner.query(
      `ALTER TABLE "gachas" ADD "soldStockBaseline" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gachas" DROP COLUMN "soldStockBaseline"`,
    );
    await queryRunner.query(`ALTER TABLE "gachas" DROP COLUMN "totalStock"`);
    await queryRunner.query(`ALTER TABLE "gachas" DROP COLUMN "imageUrl"`);
  }
}
