import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChangeImageUrlToText1787240000000 implements MigrationInterface {
  name = 'ChangeImageUrlToText1787240000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "items" ALTER COLUMN "imageUrl" TYPE text`,
    );
    await queryRunner.query(
      `ALTER TABLE "gachas" ALTER COLUMN "imageUrl" TYPE text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gachas" ALTER COLUMN "imageUrl" TYPE character varying(500)`,
    );
    await queryRunner.query(
      `ALTER TABLE "items" ALTER COLUMN "imageUrl" TYPE character varying(500)`,
    );
  }
}
