import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CapsuleOpening, InventoryItem, InventoryStatus } from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { ListInventoryQueryDto } from './dto/list-inventory.query.dto';

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(InventoryItem)
    private readonly inventoryRepository: Repository<InventoryItem>,
  ) {}

  /** Explicit desired state makes repeated PUTs safe. Never toggle in the DB. */
  async setLock(userId: number, inventoryItemId: number, locked: boolean) {
    if (
      !Number.isSafeInteger(inventoryItemId) ||
      inventoryItemId <= 0 ||
      typeof locked !== 'boolean'
    ) {
      throw new BusinessException(
        ResponseCode.VALIDATION_FAILED,
        '잠금 요청이 올바르지 않습니다',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.inventoryRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(InventoryItem);
      const item = await repository
        .createQueryBuilder('inventory')
        .setLock('pessimistic_write')
        .where('inventory.id = :inventoryItemId', { inventoryItemId })
        .andWhere('inventory.userId = :userId', { userId })
        .getOne();
      if (!item) {
        throw new BusinessException(
          ResponseCode.NOT_FOUND,
          '보관함 상품을 찾을 수 없습니다',
          HttpStatus.NOT_FOUND,
        );
      }
      if (item.status !== InventoryStatus.STORED) {
        throw new BusinessException(
          ResponseCode.CONFLICT,
          '보관중인 상품만 잠금을 변경할 수 있습니다',
          HttpStatus.CONFLICT,
        );
      }
      if (item.isLocked !== locked) {
        item.isLocked = locked;
        await repository.save(item);
      }
      return {
        inventoryItemId: item.id,
        isLocked: item.isLocked,
        status: item.status,
      };
    });
  }

  async findAll(userId: number, query: ListInventoryQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Record<string, unknown> = { userId };
    if (query.status) {
      where.status = query.status;
    }

    // Simple query (no orderBy in the DB query itself) to avoid requiring
    // composite indexes; we page via skip/take and sort in-memory below is
    // not needed here since Postgres default order + createdAt DESC on a
    // single-column filter doesn't require a composite index.
    const [rows, totalCount] = await this.inventoryRepository.findAndCount({
      where,
      relations: ['item'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const openings = rows.length
      ? await this.inventoryRepository.manager
          .getRepository(CapsuleOpening)
          .findBy({
            inventoryItemId: In(rows.map((row) => row.id)),
          })
      : [];
    const snapshots = new Map(
      openings.map((result) => [result.inventoryItemId, result.prize]),
    );
    const items = rows.map((row) => {
      const snapshot = snapshots.get(row.id);
      return {
        inventoryItemId: row.id,
        itemId: row.item.id,
        name: snapshot ? snapshot.name : row.item.name,
        rarity: snapshot ? snapshot.rarity : row.item.rarity,
        estimatedValue: snapshot
          ? snapshot.estimatedValue
          : row.item.estimatedValue,
        imageUrl: snapshot ? snapshot.imageUrl : row.item.imageUrl,
        isPremium: snapshot ? snapshot.isPremium : null,
        conversionGP: snapshot ? snapshot.conversionGP : null,
        status: row.status,
        isLocked: row.isLocked,
        acquiredAt: row.createdAt,
      };
    });

    return { items, page, limit, totalCount };
  }
}
