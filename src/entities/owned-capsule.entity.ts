import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';

@Entity('owned_capsules')
@Unique(['orderId', 'sequence'])
@Index(['orderId'])
export class OwnedCapsule {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid', { name: 'order_id' }) orderId: string;
  @Column() sequence: number;
  @Column({ type: 'varchar', length: 24, default: 'UNOPENED' }) status: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
