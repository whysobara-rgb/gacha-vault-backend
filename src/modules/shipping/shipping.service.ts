import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  InventoryItem,
  InventoryStatus,
  ShippingRequest,
  ShippingRequestItem,
  User,
  WalletTransaction,
  WalletTransactionType,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { CreateShippingRequestDto } from './dto/create-shipping-request.dto';
import { ListShippingRequestsQueryDto } from './dto/list-shipping-requests.query.dto';

/** Fixed delivery fee (GP) charged per shipping request, matching the
 *  Flutter app's DeliveryRequestPage._deliveryFee constant. */
export const DELIVERY_FEE = 3000;

@Injectable()
export class ShippingService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Creates a shipping request as one atomic transaction:
   *   1. Lock the user row, verify balance >= DELIVERY_FEE.
   *   2. Verify every requested InventoryItem belongs to the user,
   *      is not locked, and is currently STORED.
   *   3. Deduct the delivery fee, record a WalletTransaction (USE).
   *   4. Create the ShippingRequest + pivot rows.
   *   5. Flip each InventoryItem to SHIPPING_REQUESTED and lock it.
   */
  async create(userId: number, dto: CreateShippingRequestDto) {
    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const inventoryRepo = manager.getRepository(InventoryItem);
      const shippingRepo = manager.getRepository(ShippingRequest);
      const shippingItemRepo = manager.getRepository(ShippingRequestItem);
      const walletRepo = manager.getRepository(WalletTransaction);

      const user = await userRepo
        .createQueryBuilder('user')
        .setLock('pessimistic_write')
        .where('user.id = :userId', { userId })
        .getOne();

      if (!user) {
        throw new BusinessException(
          ResponseCode.NOT_FOUND,
          'User not found',
          HttpStatus.NOT_FOUND,
        );
      }

      if (Number(user.coinBalance) < DELIVERY_FEE) {
        throw new BusinessException(
          ResponseCode.INSUFFICIENT_BALANCE,
          'Insufficient balance for delivery fee',
          HttpStatus.BAD_REQUEST,
        );
      }

      const uniqueIds = Array.from(new Set(dto.inventoryItemIds));
      const items = await inventoryRepo
        .createQueryBuilder('inv')
        .setLock('pessimistic_write')
        .where('inv.id IN (:...ids)', { ids: uniqueIds })
        .getMany();

      if (items.length !== uniqueIds.length) {
        throw new BusinessException(
          ResponseCode.NOT_FOUND,
          'One or more inventory items not found',
          HttpStatus.NOT_FOUND,
        );
      }

      for (const item of items) {
        if (item.userId !== userId) {
          throw new BusinessException(
            ResponseCode.FORBIDDEN,
            'Inventory item does not belong to the current user',
            HttpStatus.FORBIDDEN,
          );
        }
        if (item.isLocked || item.status !== InventoryStatus.STORED) {
          throw new BusinessException(
            ResponseCode.CONFLICT,
            `Inventory item ${item.id} is not eligible for shipping`,
            HttpStatus.CONFLICT,
          );
        }
      }

      // Deduct delivery fee.
      user.coinBalance = Number(user.coinBalance) - DELIVERY_FEE;
      await userRepo.save(user);

      await walletRepo.save(
        walletRepo.create({
          userId: user.id,
          type: WalletTransactionType.USE,
          amount: -DELIVERY_FEE,
          description: '배송 신청 배송비',
          balanceAfter: user.coinBalance,
        }),
      );

      const shippingRequest = await shippingRepo.save(
        shippingRepo.create({
          userId: user.id,
          recipientName: dto.recipientName,
          phone: dto.phone,
          address: dto.address,
          notes: dto.notes ?? null,
        }),
      );

      for (const item of items) {
        await shippingItemRepo.save(
          shippingItemRepo.create({
            shippingRequestId: shippingRequest.id,
            inventoryItemId: item.id,
          }),
        );
        item.status = InventoryStatus.SHIPPING_REQUESTED;
        item.isLocked = true;
        await inventoryRepo.save(item);
      }

      return {
        shippingRequestId: shippingRequest.id,
        recipientName: shippingRequest.recipientName,
        phone: shippingRequest.phone,
        address: shippingRequest.address,
        notes: shippingRequest.notes,
        status: shippingRequest.status,
        deliveryFee: DELIVERY_FEE,
        inventoryItemIds: items.map((i) => i.id),
        balanceAfter: user.coinBalance,
        createdAt: shippingRequest.createdAt,
      };
    });
  }

  async findAll(userId: number, query: ListShippingRequestsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const shippingRepo = this.dataSource.getRepository(ShippingRequest);
    const [rows, totalCount] = await shippingRepo.findAndCount({
      where: { userId },
      relations: ['items', 'items.inventoryItem', 'items.inventoryItem.item'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const items = rows.map((row) => ({
      shippingRequestId: row.id,
      recipientName: row.recipientName,
      phone: row.phone,
      address: row.address,
      notes: row.notes,
      status: row.status,
      items: row.items.map((sri) => ({
        inventoryItemId: sri.inventoryItem.id,
        itemId: sri.inventoryItem.item.id,
        name: sri.inventoryItem.item.name,
        rarity: sri.inventoryItem.item.rarity,
      })),
      createdAt: row.createdAt,
    }));

    return { items, page, limit, totalCount };
  }
}
