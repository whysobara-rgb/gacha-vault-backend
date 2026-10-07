import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { ShippingRequestItem } from './shipping-request-item.entity';

export enum ShippingRequestStatus {
  REQUESTED = 'REQUESTED',
  SHIPPING = 'SHIPPING',
  DELIVERED = 'DELIVERED',
}

@Entity('shipping_requests')
export class ShippingRequest {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ type: 'varchar', length: 100 })
  recipientName: string;

  @Column({ type: 'varchar', length: 30 })
  phone: string;

  @Column({ type: 'varchar', length: 255 })
  address: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @Column({
    type: 'enum',
    enum: ShippingRequestStatus,
    default: ShippingRequestStatus.REQUESTED,
  })
  status: ShippingRequestStatus;

  /** 택배사, set by an operator when the parcel ships. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  trackingCompany: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  trackingNumber: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  shippedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @OneToMany(() => ShippingRequestItem, (sri) => sri.shippingRequest)
  items: ShippingRequestItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
