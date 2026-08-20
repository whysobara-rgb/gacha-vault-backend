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

  @OneToMany(() => GachaItem, (gachaItem) => gachaItem.gacha)
  gachaItems: GachaItem[];

  @OneToMany(() => Draw, (draw) => draw.gacha)
  draws: Draw[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
