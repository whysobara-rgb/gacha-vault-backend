import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum BannerLinkType {
  GACHA = 'GACHA',
  ATTENDANCE = 'ATTENDANCE',
  TOPUP = 'TOPUP',
  ODDS = 'ODDS',
  URL = 'URL',
  NONE = 'NONE',
}

/**
 * Home hero banners. Each one should point at a mechanic that really
 * exists (a box, 출석체크, a top-up bonus...), so the banner is never the
 * only place a promise is made.
 */
@Entity('banners')
export class Banner {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  subtitle: string | null;

  /** Small label such as "OPEN 기념". */
  @Column({ type: 'varchar', length: 30, nullable: true })
  badge: string | null;

  @Column({ type: 'text', nullable: true })
  imageUrl: string | null;

  @Column({ type: 'varchar', length: 9, nullable: true })
  accentColorHex: string | null;

  @Column({ type: 'enum', enum: BannerLinkType, default: BannerLinkType.NONE })
  linkType: BannerLinkType;

  /** Gacha id for GACHA/ODDS, an https URL for URL, otherwise null. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  linkTarget: string | null;

  /** Lower comes first. */
  @Column({ type: 'int', default: 100 })
  priority: number;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  startsAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  endsAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
