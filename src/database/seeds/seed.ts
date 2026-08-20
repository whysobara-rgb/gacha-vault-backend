/**
 * Standalone seed script — populates the database with demo data:
 *   - 2 Gachas (스타터 가치가차 / 프리미엄 가치가차)
 *   - Items across N/R/SR/SSR rarities
 *   - GachaItem pool entries (weights) linking items to each gacha
 *   - 1 demo user (demo@gachivault.com / Password1) with a coin balance
 *
 * Usage: npm run seed
 */
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import {
  User,
  Gacha,
  Item,
  GachaItem,
  Draw,
  InventoryItem,
  CurrencyType,
  ItemRarity,
} from '../../entities';

dotenv.config();

async function run() {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    entities: [User, Gacha, Item, GachaItem, Draw, InventoryItem],
    synchronize: true,
  });

  await dataSource.initialize();
  console.log('📦 Database connected. Seeding...');

  const userRepo = dataSource.getRepository(User);
  const gachaRepo = dataSource.getRepository(Gacha);
  const itemRepo = dataSource.getRepository(Item);
  const gachaItemRepo = dataSource.getRepository(GachaItem);

  // --- Demo user -----------------------------------------------------
  const existingUser = await userRepo.findOne({
    where: { email: 'demo@gachivault.com' },
  });
  if (!existingUser) {
    const hashed = await bcrypt.hash('Password1', 10);
    await userRepo.save(
      userRepo.create({
        email: 'demo@gachivault.com',
        password: hashed,
        nickname: '가치유저1',
        coinBalance: 5000,
      }),
    );
    console.log('👤 Created demo user: demo@gachivault.com / Password1');
  } else {
    console.log('👤 Demo user already exists, skipping.');
  }

  // --- Items -----------------------------------------------------------
  const itemDefs: Array<{ name: string; rarity: ItemRarity; estimatedValue: number }> = [
    { name: 'N 등급 가치 카드', rarity: ItemRarity.N, estimatedValue: 50 },
    { name: 'N 등급 행운의 열쇠고리', rarity: ItemRarity.N, estimatedValue: 80 },
    { name: 'R 등급 가치 카드', rarity: ItemRarity.R, estimatedValue: 300 },
    { name: 'R 등급 미니 피규어', rarity: ItemRarity.R, estimatedValue: 500 },
    { name: 'SR 등급 프리미엄 카드', rarity: ItemRarity.SR, estimatedValue: 2000 },
    { name: 'SR 등급 리미티드 피규어', rarity: ItemRarity.SR, estimatedValue: 3500 },
    { name: 'SSR 등급 레어 아이템', rarity: ItemRarity.SSR, estimatedValue: 15000 },
    { name: 'SSR 등급 골드 트로피', rarity: ItemRarity.SSR, estimatedValue: 25000 },
  ];

  const items: Item[] = [];
  for (const def of itemDefs) {
    let item = await itemRepo.findOne({ where: { name: def.name } });
    if (!item) {
      item = await itemRepo.save(itemRepo.create(def));
      console.log(`🎁 Created item: ${def.name}`);
    }
    items.push(item);
  }

  // --- Gachas ------------------------------------------------------------
  let starterGacha = await gachaRepo.findOne({
    where: { title: '스타터 가치가차' },
  });
  if (!starterGacha) {
    starterGacha = await gachaRepo.save(
      gachaRepo.create({
        title: '스타터 가치가차',
        description: '입문자용 가차 풀',
        price: 100,
        currency: CurrencyType.COIN,
        active: true,
      }),
    );
    console.log('🎰 Created gacha: 스타터 가치가차');
  }

  let premiumGacha = await gachaRepo.findOne({
    where: { title: '프리미엄 가치가차' },
  });
  if (!premiumGacha) {
    premiumGacha = await gachaRepo.save(
      gachaRepo.create({
        title: '프리미엄 가치가차',
        description: '고급 아이템 확률이 높은 프리미엄 가차 풀',
        price: 500,
        currency: CurrencyType.COIN,
        active: true,
      }),
    );
    console.log('🎰 Created gacha: 프리미엄 가치가차');
  }

  // --- Gacha pools (weights) ----------------------------------------------
  const starterPool = [
    { itemName: 'N 등급 가치 카드', weight: 50 },
    { itemName: 'N 등급 행운의 열쇠고리', weight: 30 },
    { itemName: 'R 등급 가치 카드', weight: 15 },
    { itemName: 'R 등급 미니 피규어', weight: 4 },
    { itemName: 'SR 등급 프리미엄 카드', weight: 1 },
  ];

  const premiumPool = [
    { itemName: 'R 등급 가치 카드', weight: 30 },
    { itemName: 'R 등급 미니 피규어', weight: 30 },
    { itemName: 'SR 등급 프리미엄 카드', weight: 25 },
    { itemName: 'SR 등급 리미티드 피규어', weight: 10 },
    { itemName: 'SSR 등급 레어 아이템', weight: 4 },
    { itemName: 'SSR 등급 골드 트로피', weight: 1 },
  ];

  async function seedPool(gacha: Gacha, pool: { itemName: string; weight: number }[]) {
    for (const entry of pool) {
      const item = items.find((i) => i.name === entry.itemName);
      if (!item) continue;
      const exists = await gachaItemRepo.findOne({
        where: { gachaId: gacha.id, itemId: item.id },
      });
      if (!exists) {
        await gachaItemRepo.save(
          gachaItemRepo.create({
            gachaId: gacha.id,
            itemId: item.id,
            weight: entry.weight,
          }),
        );
      }
    }
  }

  await seedPool(starterGacha, starterPool);
  await seedPool(premiumGacha, premiumPool);
  console.log('🔗 Linked gacha pools.');

  await dataSource.destroy();
  console.log('✅ Seeding complete.');
}

run().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
