import type { ProbabilitySnapshot } from '../modules/orders/probability';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  Unique,
} from 'typeorm';

@Entity('capsule_orders')
@Unique(['userId', 'idempotencyKey'])
export class CapsuleOrder {
  @Column({ name: 'refunded_quantity', default: 0 }) refundedQuantity: number;
  @Column({ name: 'refund_eligible', default: false }) refundEligible: boolean;
  @Column({ name: 'refund_until', type: 'timestamptz', nullable: true })
  refundUntil: Date | null;
  @Column({ name: 'refund_policy', type: 'jsonb', nullable: true })
  refundPolicy: object | null;
  @Column({ name: 'probability_snapshot', type: 'jsonb', nullable: true })
  probabilitySnapshot: ProbabilitySnapshot | null;
  @Column({
    name: 'probability_version',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  probabilityVersion: string | null;
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id' }) userId: number;
  @Column('uuid', { name: 'idempotency_key' }) idempotencyKey: string;
  @Column({ name: 'gacha_id' }) gachaId: number;
  @Column({ name: 'title_snapshot', type: 'varchar', length: 255 })
  titleSnapshot: string;
  @Column({ name: 'unit_price' }) unitPrice: number;
  @Column() quantity: number;
  @Column() total: number;
  @Column({ type: 'varchar', length: 16 }) currency: string;
  @Column({ type: 'varchar', length: 24 }) status: string;
  @Column({
    name: 'wallet_transaction_id',
    type: 'integer',
    unique: true,
    nullable: true,
  })
  walletTransactionId: number | null;
  @Column({ name: 'balance_after', type: 'bigint' }) balanceAfter: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
