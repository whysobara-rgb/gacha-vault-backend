import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSocialLoginToUsers1787230896838 implements MigrationInterface {
    name = 'AddSocialLoginToUsers1787230896838'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."users_provider_enum" AS ENUM('EMAIL', 'KAKAO', 'GOOGLE', 'NAVER', 'APPLE')`);
        await queryRunner.query(`ALTER TABLE "users" ADD "provider" "public"."users_provider_enum" NOT NULL DEFAULT 'EMAIL'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "providerId" character varying(255)`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "password" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "providerId"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "provider"`);
        await queryRunner.query(`DROP TYPE "public"."users_provider_enum"`);
    }

}
