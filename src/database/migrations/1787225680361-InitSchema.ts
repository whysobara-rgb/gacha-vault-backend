import { MigrationInterface, QueryRunner } from "typeorm";

export class InitSchema1787225680361 implements MigrationInterface {
    name = 'InitSchema1787225680361'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."inventory_items_status_enum" AS ENUM('STORED', 'SHIPPING_REQUESTED', 'SHIPPING', 'DELIVERED')`);
        await queryRunner.query(`CREATE TABLE "inventory_items" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "item_id" integer NOT NULL, "draw_id" integer, "status" "public"."inventory_items_status_enum" NOT NULL DEFAULT 'STORED', "isLocked" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_cfd8dfc5e7a565c9891db8f6f9" UNIQUE ("draw_id"), CONSTRAINT "PK_cf2f451407242e132547ac19169" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."items_rarity_enum" AS ENUM('N', 'R', 'SR', 'SSR')`);
        await queryRunner.query(`CREATE TABLE "items" ("id" SERIAL NOT NULL, "name" character varying(255) NOT NULL, "rarity" "public"."items_rarity_enum" NOT NULL DEFAULT 'N', "estimatedValue" integer NOT NULL DEFAULT '0', "imageUrl" character varying(500), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ba5885359424c15ca6b9e79bcf6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "gacha_items" ("id" SERIAL NOT NULL, "gacha_id" integer NOT NULL, "item_id" integer NOT NULL, "weight" integer NOT NULL DEFAULT '1', CONSTRAINT "PK_5129d1aaafa03735a6f4e1585fc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."gachas_currency_enum" AS ENUM('COIN', 'GP')`);
        await queryRunner.query(`CREATE TABLE "gachas" ("id" SERIAL NOT NULL, "title" character varying(255) NOT NULL, "description" text, "price" integer NOT NULL, "currency" "public"."gachas_currency_enum" NOT NULL DEFAULT 'COIN', "active" boolean NOT NULL DEFAULT true, "tagline" character varying(100), "iconName" character varying(100), "badgeLabel" character varying(50), "accentColorHex" character varying(9), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_bb7255092511fdbeeb81db1c067" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."draws_currency_enum" AS ENUM('COIN', 'GP')`);
        await queryRunner.query(`CREATE TABLE "draws" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "gacha_id" integer NOT NULL, "spent" integer NOT NULL, "currency" "public"."draws_currency_enum" NOT NULL DEFAULT 'COIN', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_abe4e6df5ea65731c53b968f8d1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "users" ("id" SERIAL NOT NULL, "email" character varying(255) NOT NULL, "password" character varying(255) NOT NULL, "nickname" character varying(100) NOT NULL, "coinBalance" bigint NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "shipping_request_items" ("id" SERIAL NOT NULL, "shipping_request_id" integer NOT NULL, "inventory_item_id" integer NOT NULL, CONSTRAINT "PK_ec247623e2fb14a4d39183bd765" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."shipping_requests_status_enum" AS ENUM('REQUESTED', 'SHIPPING', 'DELIVERED')`);
        await queryRunner.query(`CREATE TABLE "shipping_requests" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "recipientName" character varying(100) NOT NULL, "phone" character varying(30) NOT NULL, "address" character varying(255) NOT NULL, "notes" character varying(500), "status" "public"."shipping_requests_status_enum" NOT NULL DEFAULT 'REQUESTED', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_dda88f236216e361aeb20be4cc5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."wallet_transactions_type_enum" AS ENUM('EARN', 'USE', 'EXPIRE')`);
        await queryRunner.query(`CREATE TABLE "wallet_transactions" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "type" "public"."wallet_transactions_type_enum" NOT NULL, "amount" integer NOT NULL, "description" character varying(255) NOT NULL, "balanceAfter" bigint NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5120f131bde2cda940ec1a621db" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "inventory_items" ADD CONSTRAINT "FK_9368646c6eb55675ed34699583b" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "inventory_items" ADD CONSTRAINT "FK_6c06346f7daad6d05f3cdb95026" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "inventory_items" ADD CONSTRAINT "FK_cfd8dfc5e7a565c9891db8f6f98" FOREIGN KEY ("draw_id") REFERENCES "draws"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "gacha_items" ADD CONSTRAINT "FK_bbb467c846ab732613793e8c0ff" FOREIGN KEY ("gacha_id") REFERENCES "gachas"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "gacha_items" ADD CONSTRAINT "FK_20f9d4bc9466991027cb45b1864" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "draws" ADD CONSTRAINT "FK_d900649d89d893ef12942aa7bf4" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "draws" ADD CONSTRAINT "FK_a007b5fcfacc4c897279171f8f5" FOREIGN KEY ("gacha_id") REFERENCES "gachas"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "shipping_request_items" ADD CONSTRAINT "FK_75b88e58a841f3321035c0e58ce" FOREIGN KEY ("shipping_request_id") REFERENCES "shipping_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "shipping_request_items" ADD CONSTRAINT "FK_664cff6f199a7283d42ef9c2943" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "shipping_requests" ADD CONSTRAINT "FK_6a33b3751ed6e6f5b826ae04826" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wallet_transactions" ADD CONSTRAINT "FK_4796762c619893704abbc3dce65" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "wallet_transactions" DROP CONSTRAINT "FK_4796762c619893704abbc3dce65"`);
        await queryRunner.query(`ALTER TABLE "shipping_requests" DROP CONSTRAINT "FK_6a33b3751ed6e6f5b826ae04826"`);
        await queryRunner.query(`ALTER TABLE "shipping_request_items" DROP CONSTRAINT "FK_664cff6f199a7283d42ef9c2943"`);
        await queryRunner.query(`ALTER TABLE "shipping_request_items" DROP CONSTRAINT "FK_75b88e58a841f3321035c0e58ce"`);
        await queryRunner.query(`ALTER TABLE "draws" DROP CONSTRAINT "FK_a007b5fcfacc4c897279171f8f5"`);
        await queryRunner.query(`ALTER TABLE "draws" DROP CONSTRAINT "FK_d900649d89d893ef12942aa7bf4"`);
        await queryRunner.query(`ALTER TABLE "gacha_items" DROP CONSTRAINT "FK_20f9d4bc9466991027cb45b1864"`);
        await queryRunner.query(`ALTER TABLE "gacha_items" DROP CONSTRAINT "FK_bbb467c846ab732613793e8c0ff"`);
        await queryRunner.query(`ALTER TABLE "inventory_items" DROP CONSTRAINT "FK_cfd8dfc5e7a565c9891db8f6f98"`);
        await queryRunner.query(`ALTER TABLE "inventory_items" DROP CONSTRAINT "FK_6c06346f7daad6d05f3cdb95026"`);
        await queryRunner.query(`ALTER TABLE "inventory_items" DROP CONSTRAINT "FK_9368646c6eb55675ed34699583b"`);
        await queryRunner.query(`DROP TABLE "wallet_transactions"`);
        await queryRunner.query(`DROP TYPE "public"."wallet_transactions_type_enum"`);
        await queryRunner.query(`DROP TABLE "shipping_requests"`);
        await queryRunner.query(`DROP TYPE "public"."shipping_requests_status_enum"`);
        await queryRunner.query(`DROP TABLE "shipping_request_items"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TABLE "draws"`);
        await queryRunner.query(`DROP TYPE "public"."draws_currency_enum"`);
        await queryRunner.query(`DROP TABLE "gachas"`);
        await queryRunner.query(`DROP TYPE "public"."gachas_currency_enum"`);
        await queryRunner.query(`DROP TABLE "gacha_items"`);
        await queryRunner.query(`DROP TABLE "items"`);
        await queryRunner.query(`DROP TYPE "public"."items_rarity_enum"`);
        await queryRunner.query(`DROP TABLE "inventory_items"`);
        await queryRunner.query(`DROP TYPE "public"."inventory_items_status_enum"`);
    }

}
