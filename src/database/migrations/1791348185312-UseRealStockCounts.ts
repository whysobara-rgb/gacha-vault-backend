import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces the padded "sold" figure with the real one.
 *
 * - Deletes the display-only ranking accounts the old seed created
 *   (*@demo.gachivault.com without a password). Their synthetic draws,
 *   items and ledger rows cascade away, so rankings and the live win feed
 *   show only real activity. Not restored on revert.
 * - gachas.soldStockBaseline (boxes counted as sold that never were) becomes
 *   gachas.soldCount, backfilled with the boxes actually opened.
 */
export class UseRealStockCounts1791348185312 implements MigrationInterface {
  name = 'UseRealStockCounts1791348185312';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "users" WHERE "email" LIKE '%@demo.gachivault.com' AND "password" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "gachas" RENAME COLUMN "soldStockBaseline" TO "soldCount"`,
    );
    await queryRunner.query(
      `UPDATE "gachas" g SET "soldCount" = (SELECT COUNT(*) FROM "draws" d WHERE d."gacha_id" = g."id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gachas" RENAME COLUMN "soldCount" TO "soldStockBaseline"`,
    );
    // The old code added live draws on top of the baseline; 0 avoids
    // double counting.
    await queryRunner.query(`UPDATE "gachas" SET "soldStockBaseline" = 0`);
  }
}
