import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

export enum WalletTransactionType {
  EARN = 'EARN',
  USE = 'USE',
  EXPIRE = 'EXPIRE',
}

/** Why the balance changed. Monthly top-up limits sum only TOPUP rows. */
export enum WalletTransactionReason {
  TOPUP = 'TOPUP',
  /** Package volume bonus or 첫 충전 bonus; not counted toward limits. */
  BONUS = 'BONUS',
  SIGNUP_BONUS = 'SIGNUP_BONUS',
  ATTENDANCE = 'ATTENDANCE',
  EXCHANGE = 'EXCHANGE',
  DRAW = 'DRAW',
  SHIPPING_FEE = 'SHIPPING_FEE',
  ADJUSTMENT = 'ADJUSTMENT',
}

/**
 * Ledger entry for every balance change (GP/coin) a user experiences:
 * signup bonus, demo top-up (EARN), gacha draw (USE), future expiry (EXPIRE).
 * Powers the "포인트 내역" (point history) screen in the Flutter app.
 */
@Entity('wallet_transactions')
export class WalletTransaction {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ type: 'enum', enum: WalletTransactionType })
  type: WalletTransactionType;

  @Column({ type: 'enum', enum: WalletTransactionReason, nullable: true })
  reason: WalletTransactionReason | null;

  /** Signed amount: positive for EARN, negative for USE/EXPIRE. */
  @Column({ type: 'int' })
  amount: number;

  @Column({ type: 'varchar', length: 255 })
  description: string;

  /** User's coinBalance snapshot immediately after this transaction. */
  @Column({ type: 'bigint' })
  balanceAfter: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
