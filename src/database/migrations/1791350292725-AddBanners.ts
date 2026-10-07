import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBanners1791350292725 implements MigrationInterface {
  name = 'AddBanners1791350292725';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."banners_linktype_enum" AS ENUM('GACHA', 'ATTENDANCE', 'TOPUP', 'ODDS', 'URL', 'NONE')`,
    );
    await queryRunner.query(
      `CREATE TABLE "banners" ("id" SERIAL NOT NULL, "title" character varying(100) NOT NULL, "subtitle" character varying(200), "badge" character varying(30), "imageUrl" text, "accentColorHex" character varying(9), "linkType" "public"."banners_linktype_enum" NOT NULL DEFAULT 'NONE', "linkTarget" character varying(500), "priority" integer NOT NULL DEFAULT '100', "active" boolean NOT NULL DEFAULT true, "startsAt" TIMESTAMP WITH TIME ZONE, "endsAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e9b186b959296fcb940790d31c3" PRIMARY KEY ("id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "banners"`);
    await queryRunner.query(`DROP TYPE "public"."banners_linktype_enum"`);
  }
}
