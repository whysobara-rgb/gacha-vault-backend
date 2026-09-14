import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { PrizeSnapshot } from '../modules/orders/probability';
@Entity('capsule_openings')
export class CapsuleOpening {
  @PrimaryColumn('uuid', { name: 'capsule_id' }) capsuleId: string;
  @Column({ name: 'inventory_item_id', unique: true }) inventoryItemId: number;
  @Column({ name: 'probability_version', type: 'varchar', length: 64 })
  probabilityVersion: string;
  @Column({ type: 'jsonb' }) prize: PrizeSnapshot;
  @Column({ type: 'integer' }) ticket: number;
  @CreateDateColumn({ name: 'opened_at', type: 'timestamptz' }) openedAt: Date;
}
