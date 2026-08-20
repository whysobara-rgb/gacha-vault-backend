/**
 * Standalone seed script — populates the database with demo data:
 *   - 8 Gachas matching the Flutter app's CapsuleBoxRepository dummy list
 *     (title/tagline/iconName/badgeLabel/accentColorHex/price in GP)
 *   - Items across N/R/SR/SSR rarities, shared across gacha pools
 *   - GachaItem pool entries (weights) linking items to each gacha
 *   - 1 demo user (demo@gachivault.com / Password1) with a GP balance
 *   - An initial WalletTransaction (EARN) recording the starting balance
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
  ShippingRequest,
  ShippingRequestItem,
  WalletTransaction,
  CurrencyType,
  ItemRarity,
  WalletTransactionType,
} from '../../entities';

dotenv.config();

const STARTING_BALANCE = 5000;

async function run() {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    entities: [
      User,
      Gacha,
      Item,
      GachaItem,
      Draw,
      InventoryItem,
      ShippingRequest,
      ShippingRequestItem,
      WalletTransaction,
    ],
    synchronize: true,
  });

  await dataSource.initialize();
  console.log('📦 Database connected. Seeding...');

  const userRepo = dataSource.getRepository(User);
  const gachaRepo = dataSource.getRepository(Gacha);
  const itemRepo = dataSource.getRepository(Item);
  const gachaItemRepo = dataSource.getRepository(GachaItem);
  const walletRepo = dataSource.getRepository(WalletTransaction);

  // --- Demo user -----------------------------------------------------
  let demoUser = await userRepo.findOne({
    where: { email: 'demo@gachivault.com' },
  });
  if (!demoUser) {
    const hashed = await bcrypt.hash('Password1', 10);
    demoUser = await userRepo.save(
      userRepo.create({
        email: 'demo@gachivault.com',
        password: hashed,
        nickname: '가치유저1',
        coinBalance: STARTING_BALANCE,
      }),
    );
    console.log('👤 Created demo user: demo@gachivault.com / Password1');

    await walletRepo.save(
      walletRepo.create({
        userId: demoUser.id,
        type: WalletTransactionType.EARN,
        amount: STARTING_BALANCE,
        description: '회원가입 축하 GP',
        balanceAfter: STARTING_BALANCE,
      }),
    );
  } else if (Number(demoUser.coinBalance) < 500) {
    // Testing has drained this account before — top it back up so manual
    // API testing / Flutter integration testing has something to spend.
    const topup = STARTING_BALANCE - Number(demoUser.coinBalance);
    demoUser.coinBalance = STARTING_BALANCE;
    await userRepo.save(demoUser);
    await walletRepo.save(
      walletRepo.create({
        userId: demoUser.id,
        type: WalletTransactionType.EARN,
        amount: topup,
        description: 'GP 충전 (seed 재보충)',
        balanceAfter: STARTING_BALANCE,
      }),
    );
    console.log(`👤 Demo user balance topped back up to ${STARTING_BALANCE}.`);
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
  // Mirrors lib/features/home/data/capsule_box_repository.dart exactly so
  // the Flutter home screen grid can be driven 1:1 by GET /gachas once the
  // dummy CapsuleBoxRepository is swapped for a real API call.
  interface GachaDef {
    title: string;
    tagline: string;
    price: number; // GP cost per draw
    iconName: string;
    badgeLabel: string | null;
    accentColorHex: string;
    description: string;
    pool: { itemName: string; weight: number }[];
  }

  const commonPool = [
    { itemName: 'N 등급 가치 카드', weight: 45 },
    { itemName: 'N 등급 행운의 열쇠고리', weight: 30 },
    { itemName: 'R 등급 가치 카드', weight: 15 },
    { itemName: 'R 등급 미니 피규어', weight: 7 },
    { itemName: 'SR 등급 프리미엄 카드', weight: 2 },
    { itemName: 'SR 등급 리미티드 피규어', weight: 0.7 },
    { itemName: 'SSR 등급 레어 아이템', weight: 0.25 },
    { itemName: 'SSR 등급 골드 트로피', weight: 0.05 },
  ];

  const premiumPool = [
    { itemName: 'R 등급 가치 카드', weight: 30 },
    { itemName: 'R 등급 미니 피규어', weight: 30 },
    { itemName: 'SR 등급 프리미엄 카드', weight: 25 },
    { itemName: 'SR 등급 리미티드 피규어', weight: 10 },
    { itemName: 'SSR 등급 레어 아이템', weight: 4 },
    { itemName: 'SSR 등급 골드 트로피', weight: 1 },
  ];

  const gachaDefs: GachaDef[] = [
    {
      title: '명품 시계 박스',
      tagline: 'PREMIUM HIT!',
      price: 500,
      iconName: 'watch_rounded',
      badgeLabel: 'SPECIAL',
      accentColorHex: '#B8860B',
      description: '프리미엄 시계가 포함된 랜덤박스',
      pool: premiumPool,
    },
    {
      title: '애플 대란',
      tagline: 'TECH ZONE!',
      price: 500,
      iconName: 'phone_iphone',
      badgeLabel: null,
      accentColorHex: '#3C3C3C',
      description: '최신 디지털 기기 랜덤박스',
      pool: premiumPool,
    },
    {
      title: '패션 럭키박스',
      tagline: 'FASHION HIT!',
      price: 500,
      iconName: 'checkroom',
      badgeLabel: 'NEW',
      accentColorHex: '#6A3FBF',
      description: '트렌디한 패션 아이템 랜덤박스',
      pool: commonPool,
    },
    {
      title: '뷰티 럭키박스',
      tagline: 'BEAUTY SPECIAL!',
      price: 500,
      iconName: 'face_retouching_natural',
      badgeLabel: 'SPECIAL',
      accentColorHex: '#D6558C',
      description: '뷰티 & 코스메틱 랜덤박스',
      pool: commonPool,
    },
    {
      title: '명품 가방 박스',
      tagline: 'LUXURY BOX',
      price: 750,
      iconName: 'shopping_bag',
      badgeLabel: null,
      accentColorHex: '#8A6D3B',
      description: '명품 가방이 포함된 럭셔리 랜덤박스',
      pool: premiumPool,
    },
    {
      title: '가전 프리미엄',
      tagline: 'DIGITAL PRO',
      price: 400,
      iconName: 'devices',
      badgeLabel: 'NEW',
      accentColorHex: '#2A7DAF',
      description: '프리미엄 가전제품 랜덤박스',
      pool: commonPool,
    },
    {
      title: '식품 랜덤박스',
      tagline: 'FOOD LUCKY',
      price: 250,
      iconName: 'restaurant',
      badgeLabel: null,
      accentColorHex: '#4C8C4A',
      description: '맛있는 식품 랜덤박스',
      pool: commonPool,
    },
    {
      title: '기프티콘 모음',
      tagline: 'GIFTICON BOX',
      price: 150,
      iconName: 'card_giftcard',
      badgeLabel: null,
      accentColorHex: '#9AA0A6',
      description: '다양한 기프티콘 랜덤박스',
      pool: commonPool,
    },
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
            weight: Math.max(1, Math.round(entry.weight * 10)), // avoid 0-weight rounding
          }),
        );
      }
    }
  }

  for (const def of gachaDefs) {
    let gacha = await gachaRepo.findOne({ where: { title: def.title } });
    if (!gacha) {
      gacha = await gachaRepo.save(
        gachaRepo.create({
          title: def.title,
          description: def.description,
          price: def.price,
          currency: CurrencyType.GP,
          active: true,
          tagline: def.tagline,
          iconName: def.iconName,
          badgeLabel: def.badgeLabel,
          accentColorHex: def.accentColorHex,
        }),
      );
      console.log(`🎰 Created gacha: ${def.title}`);
    } else {
      // Keep display metadata in sync on repeated seed runs.
      gacha.tagline = def.tagline;
      gacha.iconName = def.iconName;
      gacha.badgeLabel = def.badgeLabel;
      gacha.accentColorHex = def.accentColorHex;
      gacha.price = def.price;
      gacha.currency = CurrencyType.GP;
      await gachaRepo.save(gacha);
    }
    await seedPool(gacha, def.pool);
  }

  // Deactivate the older 스타터/프리미엄 가차 test gachas (kept in DB for
  // historical Draw/InventoryItem foreign-key integrity from earlier
  // manual API testing), so GET /gachas (active-only) returns exactly the
  // 8 gachas the Flutter home screen expects.
  await gachaRepo
    .createQueryBuilder()
    .update(Gacha)
    .set({ active: false })
    .where('title IN (:...titles)', {
      titles: ['스타터 가치가차', '프리미엄 가치가차'],
    })
    .execute();

  console.log('🔗 Linked gacha pools.');

  await dataSource.destroy();
  console.log('✅ Seeding complete.');
}

run().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
