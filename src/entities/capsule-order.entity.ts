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
  @Column({ name: 'wallet_transaction_id', unique: true })
  walletTransactionId: number;
  @Column({ name: 'balance_after', type: 'bigint' }) balanceAfter: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
