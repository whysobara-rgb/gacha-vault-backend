import { ItemRarity } from '../../entities/item-rarity.enum';
import { BannerLinkType } from '../../entities/banner.entity';

/**
 * 출시용 상품 구성. 시드가 이 파일을 그대로 DB에 반영한다.
 *
 * 가격 단위는 원(1 GP = 1원). 상품 가치(value)는:
 *   - 상품권/기프티콘/기프트카드: 액면가 (정확)
 *   - 그 외 브랜드 상품: 2026년 10월 기준 국내 정가 추정치
 * ⚠️ 추정치는 사용자에게 "정가"로 노출되므로 출시 전 실제 정가/매입가로
 *    반드시 갱신하고, 당첨 확률 대비 실물 재고를 확보해 둘 것.
 *
 * 등급별 확률은 직접 정하지 않는다. 시드가 박스마다 목표 환급률
 * (targetPayoutRatio, 기본 TARGET_PAYOUT_RATIO)에 맞게 등급별 가중치를
 * 역산하고, 같은 등급 안의 상품은 같은 확률로 나눈다.
 */

export interface CatalogItem {
  name: string;
  rarity: ItemRarity;
  value: number;
}

export interface CatalogBox {
  /** Stable key used to link banners to boxes. */
  key: string;
  title: string;
  tagline: string;
  description: string;
  price: number;
  /** Boxes in this round; the box sells out when they are opened. */
  totalStock: number;
  pityThreshold: number;
  /** Overrides TARGET_PAYOUT_RATIO, e.g. for a launch promotion. */
  targetPayoutRatio?: number;
  iconName: string;
  badgeLabel: string | null;
  accentColorHex: string;
  imageUrl: string | null;
  items: CatalogItem[];
}

// Boxes ship without photos: the app draws each box's package art from its
// accent color and category. Set imageUrl only to a licensed photo the
// operator owns; item photos likewise.

const { SSR, SR, R, N } = ItemRarity;

export const LAUNCH_CATALOG: CatalogBox[] = [
  {
    key: 'grand-open',
    title: '그랜드 오픈 기념 박스',
    tagline: '오픈 기념 3,000개 한정',
    description:
      '오픈 기념으로 환급률을 90%(10+1은 99%)로 높인 한정 박스. 커피 기프티콘부터 에어팟 프로까지.',
    price: 5000,
    totalStock: 3000,
    pityThreshold: 400,
    targetPayoutRatio: 0.9,
    iconName: 'celebration',
    badgeLabel: 'OPEN 기념',
    accentColorHex: '#C9A227',
    imageUrl: null,
    items: [
      { name: '애플 에어팟 프로', rarity: SSR, value: 369000 },
      { name: '신세계상품권 5만원', rarity: SR, value: 50000 },
      { name: '배달의민족 상품권 3만원', rarity: SR, value: 30000 },
      { name: '스타벅스 e카드 1만원', rarity: R, value: 10000 },
      { name: 'CU 모바일상품권 5천원', rarity: R, value: 5000 },
      { name: '메가MGC커피 아메리카노', rarity: N, value: 2000 },
      { name: 'GS25 모바일상품권 2천원', rarity: N, value: 2000 },
    ],
  },
  {
    key: 'gifticon',
    title: '기프티콘 박스',
    tagline: '하루 한 번, 가볍게',
    description:
      '편의점 상품권부터 백화점 상품권 10만원까지, 전부 액면가 그대로.',
    price: 3000,
    totalStock: 30000,
    pityThreshold: 300,
    iconName: 'card_giftcard',
    badgeLabel: null,
    accentColorHex: '#3D7BF7',
    imageUrl: null,
    items: [
      { name: '신세계상품권 10만원', rarity: SSR, value: 100000 },
      { name: '배달의민족 상품권 2만원', rarity: SR, value: 20000 },
      { name: '스타벅스 e카드 2만원', rarity: SR, value: 20000 },
      { name: '스타벅스 카페 아메리카노 T', rarity: R, value: 4700 },
      { name: '배스킨라빈스 싱글레귤러', rarity: R, value: 3900 },
      { name: 'GS25 모바일상품권 1천원', rarity: N, value: 1000 },
      { name: 'CU 모바일상품권 1천원', rarity: N, value: 1000 },
    ],
  },
  {
    key: 'beauty',
    title: '뷰티 박스',
    tagline: '다이슨 에어랩을 노려라',
    description:
      '올리브영 기프트카드부터 조말론, 다이슨 에어랩까지 담은 뷰티 박스.',
    price: 14900,
    totalStock: 10000,
    pityThreshold: 400,
    iconName: 'face_retouching_natural',
    badgeLabel: null,
    accentColorHex: '#D6558C',
    imageUrl: null,
    items: [
      { name: '다이슨 에어랩 멀티 스타일러', rarity: SSR, value: 749000 },
      { name: '조말론 런던 코롱 30ml', rarity: SR, value: 117000 },
      { name: '디올 어딕트 립 글로우', rarity: SR, value: 53000 },
      { name: '라로슈포제 시카플라스트 밤 B5 100ml', rarity: R, value: 33000 },
      { name: '올리브영 기프트카드 2만원', rarity: R, value: 20000 },
      { name: '올리브영 기프트카드 5천원', rarity: N, value: 5000 },
      { name: '브랜드 핸드크림 미니 30ml', rarity: N, value: 5000 },
    ],
  },
  {
    key: 'tech',
    title: '테크 액세서리 박스',
    tagline: '에어팟 맥스 라인업',
    description:
      '충전기와 케이블부터 에어팟 4, 에어팟 맥스까지 매일 쓰는 테크 아이템.',
    price: 14900,
    totalStock: 10000,
    pityThreshold: 500,
    iconName: 'headphones',
    badgeLabel: 'NEW',
    accentColorHex: '#2A7DAF',
    imageUrl: null,
    items: [
      { name: '애플 에어팟 맥스', rarity: SSR, value: 769000 },
      { name: '애플 에어팟 4', rarity: SR, value: 199000 },
      { name: '로지텍 MX Master 3S', rarity: SR, value: 139000 },
      { name: '앤커 나노 고속충전기 30W', rarity: R, value: 35000 },
      { name: '애플 정품 USB-C 케이블 1m', rarity: R, value: 29000 },
      { name: '스마트폰 강화유리 필름 2매', rarity: N, value: 6000 },
      { name: '케이블 정리 홀더 세트', rarity: N, value: 4000 },
    ],
  },
  {
    key: 'appliance',
    title: '가전 박스',
    tagline: '다이슨 V15가 들어 있는 박스',
    description:
      '미니 가전부터 발뮤다 토스터, 다이슨 무선청소기까지 홈 가전 박스.',
    price: 29900,
    totalStock: 6000,
    pityThreshold: 500,
    iconName: 'devices',
    badgeLabel: null,
    accentColorHex: '#4C8C4A',
    imageUrl: null,
    items: [
      { name: '다이슨 V15 디텍트 무선청소기', rarity: SSR, value: 1190000 },
      { name: '발뮤다 더 토스터', rarity: SR, value: 399000 },
      { name: '필립스 에어프라이어 XXL', rarity: SR, value: 329000 },
      { name: '필립스 소닉케어 전동칫솔', rarity: R, value: 89000 },
      { name: '브라운 전기면도기 시리즈 3', rarity: R, value: 79000 },
      { name: '휴대용 미니 선풍기', rarity: N, value: 10000 },
      { name: '무선 미니 가습기', rarity: N, value: 10000 },
    ],
  },
  {
    key: 'apple',
    title: '애플 박스',
    tagline: '아이폰 프로 · 맥북 에어',
    description:
      '애플 기프트카드부터 애플워치, 아이폰 프로와 맥북 에어까지 애플 전용 박스.',
    price: 49000,
    totalStock: 5000,
    pityThreshold: 400,
    iconName: 'phone_iphone',
    badgeLabel: 'HOT',
    accentColorHex: '#3C3C3C',
    imageUrl: null,
    items: [
      { name: '애플 아이폰 프로 256GB', rarity: SSR, value: 1700000 },
      { name: '애플 맥북 에어 13', rarity: SSR, value: 1590000 },
      { name: '애플 에어팟 프로', rarity: SR, value: 369000 },
      { name: '애플 워치 SE', rarity: SR, value: 359000 },
      { name: '애플 에어태그 4팩', rarity: R, value: 129000 },
      { name: '애플 맥세이프 충전기', rarity: R, value: 59000 },
      { name: '애플 기프트카드 2만원', rarity: N, value: 20000 },
      { name: '애플 기프트카드 1만원', rarity: N, value: 10000 },
    ],
  },
  {
    key: 'luxury',
    title: '명품 잡화 박스',
    tagline: '구찌 · 프라다 숄더백',
    description: '명품 향수 미니어처부터 카드케이스, 구찌와 프라다 숄더백까지.',
    price: 59000,
    totalStock: 5000,
    pityThreshold: 400,
    iconName: 'shopping_bag',
    badgeLabel: null,
    accentColorHex: '#8A6D3B',
    imageUrl: null,
    items: [
      { name: '프라다 리나일론 숄더백', rarity: SSR, value: 2500000 },
      { name: '구찌 GG 마몬트 미니 숄더백', rarity: SSR, value: 2400000 },
      { name: '구찌 GG 마몬트 카드케이스', rarity: SR, value: 590000 },
      {
        name: '메종 마르지엘라 레플리카 오 드 뚜왈렛 100ml',
        rarity: SR,
        value: 220000,
      },
      { name: '메종 키츠네 폭스헤드 반팔 티셔츠', rarity: R, value: 150000 },
      { name: '폴로 랄프로렌 베이스볼 캡', rarity: R, value: 89000 },
      { name: '명품 브랜드 향수 미니어처', rarity: N, value: 15000 },
      { name: '신세계상품권 2만원', rarity: N, value: 20000 },
    ],
  },
  {
    key: 'dream',
    title: '드림 박스',
    tagline: '롤렉스 · 샤넬 SSR',
    description:
      '최소 백화점 상품권 3만원, 최고 롤렉스 서브마리너와 샤넬 클래식 플랩백까지 담은 최고가 박스.',
    price: 99000,
    totalStock: 2000,
    pityThreshold: 1500,
    iconName: 'diamond',
    badgeLabel: 'DREAM',
    accentColorHex: '#B8862B',
    imageUrl: null,
    items: [
      { name: '롤렉스 서브마리너 데이트', rarity: SSR, value: 16000000 },
      { name: '샤넬 클래식 플랩백 미디엄', rarity: SSR, value: 16000000 },
      { name: '애플 맥북 프로 14', rarity: SR, value: 2400000 },
      { name: '루이비통 포쉐트 악세수아', rarity: SR, value: 1700000 },
      { name: '애플 아이패드 에어', rarity: R, value: 900000 },
      { name: '다이슨 에어랩 멀티 스타일러', rarity: R, value: 749000 },
      { name: '신세계상품권 3만원', rarity: N, value: 30000 },
      { name: '현대백화점 상품권 3만원', rarity: N, value: 30000 },
    ],
  },
];

export interface CatalogBanner {
  title: string;
  subtitle: string;
  badge: string | null;
  accentColorHex: string;
  linkType: BannerLinkType;
  /** Box key for GACHA/ODDS links; resolved to the box id by the seed. */
  linkBoxKey?: string;
  priority: number;
  /** Days from seeding until the banner ends; omitted = no end date. */
  durationDays?: number;
}

/**
 * 출시 배너. 각 배너는 실제로 동작하는 혜택만 가리킨다:
 * 한정 박스(재고/확률 공개), 첫 충전 보너스(결제 시 지급), 출석체크,
 * 10+1, 천장.
 */
export const LAUNCH_BANNERS: CatalogBanner[] = [
  {
    title: '그랜드 오픈 기념 박스',
    subtitle: '3,000개 한정 · 환급률 90%, 10+1은 99%',
    badge: 'OPEN 기념',
    accentColorHex: '#C9A227',
    linkType: BannerLinkType.GACHA,
    linkBoxKey: 'grand-open',
    priority: 10,
    durationDays: 14,
  },
  {
    title: '첫 충전 20% 추가 적립',
    subtitle: '첫 결제 1회 · 최대 10,000 GP',
    badge: '첫 충전',
    accentColorHex: '#0B6E4F',
    linkType: BannerLinkType.TOPUP,
    priority: 20,
  },
  {
    title: '매일 출석하면 최대 500 GP',
    subtitle: '7일 연속 출석 보상',
    badge: '출석체크',
    accentColorHex: '#3D7BF7',
    linkType: BannerLinkType.ATTENDANCE,
    priority: 30,
  },
  {
    title: '10회 뽑으면 1회 더',
    subtitle: '모든 박스 10+1 상시 진행',
    badge: '10+1',
    accentColorHex: '#7A3FE0',
    linkType: BannerLinkType.ODDS,
    priority: 40,
  },
  {
    title: '천장이 있어 끝이 보입니다',
    subtitle: '정해진 횟수 안에 SSR 확정',
    badge: '천장',
    accentColorHex: '#B8862B',
    linkType: BannerLinkType.ODDS,
    priority: 50,
  },
  {
    title: '드림 박스',
    subtitle: '롤렉스 · 샤넬 SSR · 확률은 박스에서 공개',
    badge: 'DREAM',
    accentColorHex: '#1A1A1A',
    linkType: BannerLinkType.GACHA,
    linkBoxKey: 'dream',
    priority: 60,
  },
];
