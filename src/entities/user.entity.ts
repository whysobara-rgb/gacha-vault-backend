import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Draw } from './draw.entity';
import { InventoryItem } from './inventory-item.entity';

export enum UserRole {
  USER = 'USER',
  /** Operators: shipping, boxes, banners and stats under /admin. */
  ADMIN = 'ADMIN',
}

export enum AuthProvider {
  EMAIL = 'EMAIL',
  KAKAO = 'KAKAO',
  GOOGLE = 'GOOGLE',
  NAVER = 'NAVER',
  APPLE = 'APPLE',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  // Nullable because social-login users are provisioned without a local
  // password (they authenticate via the external provider instead).
  @Column({ type: 'varchar', length: 255, select: false, nullable: true })
  password: string | null;

  @Column({ type: 'varchar', length: 100 })
  nickname: string;

  @Column({ type: 'bigint', default: 0 })
  coinBalance: number;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Column({
    type: 'enum',
    enum: AuthProvider,
    default: AuthProvider.EMAIL,
  })
  provider: AuthProvider;

  // External provider's unique user id (Kakao/Google/Naver/Apple `sub`/`id`).
  // Null for plain EMAIL accounts.
  @Column({ type: 'varchar', length: 255, nullable: true })
  providerId: string | null;

  /** Self-set cap on GP top-ups per KST calendar month. Null = no cap. */
  @Column({ type: 'int', nullable: true })
  monthlyTopupLimit: number | null;

  /**
   * A requested raise/removal of monthlyTopupLimit, applied once
   * pendingTopupLimitEffectiveAt passes. A pending change exists iff
   * pendingTopupLimitEffectiveAt is set (a null limit then means "remove").
   */
  @Column({ type: 'int', nullable: true })
  pendingMonthlyTopupLimit: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  pendingTopupLimitEffectiveAt: Date | null;

  /**
   * When the user accepted the required terms: 이용약관, 개인정보 수집·이용,
   * and being 만 14세 이상. Null for accounts created before consent existed.
   */
  @Column({ type: 'timestamptz', nullable: true })
  termsAgreedAt: Date | null;

  /** Optional 마케팅 수신 동의; null when not agreed or withdrawn. */
  @Column({ type: 'timestamptz', nullable: true })
  marketingAgreedAt: Date | null;

  /**
   * Set on 회원 탈퇴. The row is kept (payment and order records must be
   * retained) but personal data is wiped and the account can't sign in.
   */
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @OneToMany(() => Draw, (draw) => draw.user)
  draws: Draw[];

  @OneToMany(() => InventoryItem, (inventoryItem) => inventoryItem.user)
  inventoryItems: InventoryItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
