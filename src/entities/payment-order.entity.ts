import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

export enum PaymentOrderStatus {
  /** Created; the user has not finished paying yet. */
  READY = 'READY',
  /** Sent to Toss for approval; outcome may still be unknown. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Approved by Toss and GP credited. */
  DONE = 'DONE',
  FAILED = 'FAILED',
  /** Approved, then cancelled/refunded on the Toss side. */
  CANCELED = 'CANCELED',
}

/** One GP purchase through Toss Payments. orderId is what Toss sees. */
@Entity('payment_orders')
export class PaymentOrder {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  orderId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ type: 'varchar', length: 30 })
  packageId: string;

  /** Amount charged in 원. Checked against Toss before crediting. */
  @Column({ type: 'int' })
  amount: number;

  /** Purchased GP (equals amount). */
  @Column({ type: 'int' })
  gp: number;

  /** Package volume bonus. */
  @Column({ type: 'int', default: 0 })
  bonusGp: number;

  /** 첫 충전 bonus, decided when the payment is approved. */
  @Column({ type: 'int', default: 0 })
  firstTopupBonusGp: number;

  @Column({
    type: 'enum',
    enum: PaymentOrderStatus,
    default: PaymentOrderStatus.READY,
  })
  status: PaymentOrderStatus;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 200, nullable: true })
  paymentKey: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  method: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
