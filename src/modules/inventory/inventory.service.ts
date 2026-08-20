import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InventoryItem } from '../../entities';
import { ListInventoryQueryDto } from './dto/list-inventory.query.dto';

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(InventoryItem)
    private readonly inventoryRepository: Repository<InventoryItem>,
  ) {}

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

    const items = rows.map((row) => ({
      inventoryItemId: row.id,
      itemId: row.item.id,
      name: row.item.name,
      rarity: row.item.rarity,
      estimatedValue: row.item.estimatedValue,
      imageUrl: row.item.imageUrl,
      status: row.status,
      isLocked: row.isLocked,
      acquiredAt: row.createdAt,
    }));

    return { items, page, limit, totalCount };
  }
}
