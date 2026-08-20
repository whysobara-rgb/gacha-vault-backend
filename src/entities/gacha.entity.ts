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
   * 이번 시즌/회차 한정 총 재고 수량. 상세페이지의 "OOO/전체" 진행률 표시에 사용.
   */
  @Column({ type: 'int', default: 10000 })
  totalStock: number;

  /**
   * 판매(개봉) 수량의 기준값(baseline). 실제 서비스 초기에는 draws 테이블의
   * 실제 뽑기 기록이 적을 수 있으므로, 이미 판매된 것으로 간주하는 기준
   * 수량을 박스마다 다르게 설정해 "OOO/전체" 표시가 박스별로 자연스럽게
   * 다른 값을 갖도록 한다. 최종 판매 수량 = soldStockBaseline + 실제 draws 카운트
   * 이므로, 실제 구매가 발생할 때마다 값이 함께 올라가는 진짜 "실시간" 값이 된다.
   */
  @Column({ type: 'int', default: 0 })
  soldStockBaseline: number;

  @OneToMany(() => GachaItem, (gachaItem) => gachaItem.gacha)
  gachaItems: GachaItem[];

  @OneToMany(() => Draw, (draw) => draw.gacha)
  draws: Draw[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
