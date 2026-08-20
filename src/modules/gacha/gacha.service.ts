import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gacha, GachaItem, Draw } from '../../entities';
import { ListGachasQueryDto } from './dto/list-gachas.query.dto';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';

@Injectable()
export class GachaService {
  constructor(
    @InjectRepository(Gacha)
    private readonly gachaRepository: Repository<Gacha>,
    @InjectRepository(GachaItem)
    private readonly gachaItemRepository: Repository<GachaItem>,
    @InjectRepository(Draw)
    private readonly drawRepository: Repository<Draw>,
  ) {}

  async findAll(query: ListGachasQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [items, totalCount] = await this.gachaRepository.findAndCount({
      where: { active: true },
      order: { id: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      items: items.map((gacha) => ({
        id: gacha.id,
        title: gacha.title,
        description: gacha.description,
        price: gacha.price,
        currency: gacha.currency,
        active: gacha.active,
        tagline: gacha.tagline,
        iconName: gacha.iconName,
        badgeLabel: gacha.badgeLabel,
        accentColorHex: gacha.accentColorHex,
        imageUrl: gacha.imageUrl,
      })),
      page,
      limit,
      totalCount,
    };
  }

  /**
   * Gacha detail: real-time sold stock (soldStockBaseline + live draw count
   * for this gacha) plus the actual drop-pool lineup (item name/rarity/
   * image/weight), so the Flutter "LUCKY LINEUP" section always reflects
   * exactly what can be won from *this* specific box — never a hardcoded
   * generic list.
   */
  async findOne(id: number) {
    const gacha = await this.gachaRepository.findOne({ where: { id } });
    if (!gacha) {
      throw new BusinessException(
        ResponseCode.NOT_FOUND,
        'Gacha not found',
        HttpStatus.NOT_FOUND,
      );
    }

    const [liveDrawCount, pool] = await Promise.all([
      this.drawRepository.count({ where: { gachaId: gacha.id } }),
      this.gachaItemRepository.find({
        where: { gachaId: gacha.id },
        relations: ['item'],
      }),
    ]);

    const soldStock = Math.min(
      gacha.totalStock,
      gacha.soldStockBaseline + liveDrawCount,
    );

    // Rarity rank drives lineup display order: rarest first, like TIF's
    // "LUCKY LINEUP" hero-first layout.
    const rarityRank: Record<string, number> = { SSR: 0, SR: 1, R: 2, N: 3 };
    const lineup = [...pool]
      .sort((a, b) => rarityRank[a.item.rarity] - rarityRank[b.item.rarity])
      .map((entry) => ({
        itemId: entry.item.id,
        name: entry.item.name,
        rarity: entry.item.rarity,
        estimatedValue: entry.item.estimatedValue,
        imageUrl: entry.item.imageUrl,
        weight: entry.weight,
      }));

    return {
      id: gacha.id,
      title: gacha.title,
      description: gacha.description,
      price: gacha.price,
      currency: gacha.currency,
      active: gacha.active,
      tagline: gacha.tagline,
      iconName: gacha.iconName,
      badgeLabel: gacha.badgeLabel,
      accentColorHex: gacha.accentColorHex,
      imageUrl: gacha.imageUrl,
      totalStock: gacha.totalStock,
      soldStock,
      lineup,
    };
  }
}
