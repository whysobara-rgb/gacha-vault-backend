import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GachaItem } from './gacha-item.entity';
import { Draw } from './draw.entity';

export enum CurrencyType {
  COIN = 'COIN',
  GP = 'GP',
}

@Entity('gachas')
export class Gacha {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'int' })
  price: number;

  @Column({ type: 'enum', enum: CurrencyType, default: CurrencyType.COIN })
  currency: CurrencyType;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  /** 홍보용 태그라인 (예: "PREMIUM HIT!"). Flutter CapsuleBox.tagline과 매핑. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  tagline: string | null;

  /**
   * 대표 아이콘 식별자 (Flutter Icons.xxx_rounded의 이름 문자열).
   * 예: 'watch_rounded', 'phone_iphone'. 클라이언트가 IconData로 매핑.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  iconName: string | null;

  /** 카드 좌상단 뱃지 라벨 (예: SPECIAL, NEW). 없으면 null. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  badgeLabel: string | null;

  /** 카드 썸네일 그라데이션 포인트 컬러 (hex, 예: '#B8860B'). */
  @Column({ type: 'varchar', length: 9, nullable: true })
  accentColorHex: string | null;

  /**
   * 실제 상품 사진 URL. 카드 썸네일/상세 배너에 아이콘 대신 사용된다.
   * null인 경우 클라이언트가 iconName 기반 폴백을 사용한다.
   */
  @Column({ type: 'text', nullable: true })
  imageUrl: string | null;

  /**
   * 이번 회차에 판매하는 박스 수. soldCount가 여기에 도달하면 품절되어
   * 더 이상 뽑을 수 없다. 상세페이지의 "OOO/전체" 진행률 표시에 사용.
   */
  @Column({ type: 'int', default: 10000 })
  totalStock: number;

  /**
   * 실제로 열린 박스 수(보너스 뽑기 포함). 뽑기 트랜잭션이 원자적으로
   * 증가시키며, totalStock을 넘을 수 없다.
   */
  @Column({ type: 'int', default: 0 })
  soldCount: number;

  /**
   * 천장: the Nth consecutive draw without an SSR is guaranteed to be SSR.
   * Null disables pity for this box. Disclosed via GET /gachas/:id/odds.
   */
  @Column({ type: 'int', nullable: true })
  pityThreshold: number | null;

  @OneToMany(() => GachaItem, (gachaItem) => gachaItem.gacha)
  gachaItems: GachaItem[];

  @OneToMany(() => Draw, (draw) => draw.gacha)
  draws: Draw[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
