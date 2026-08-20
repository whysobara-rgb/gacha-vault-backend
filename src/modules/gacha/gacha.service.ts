import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Gacha } from '../../entities';
import { ListGachasQueryDto } from './dto/list-gachas.query.dto';

@Injectable()
export class GachaService {
  constructor(
    @InjectRepository(Gacha)
    private readonly gachaRepository: Repository<Gacha>,
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
      })),
      page,
      limit,
      totalCount,
    };
  }
}
