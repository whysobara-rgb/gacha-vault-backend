import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Banner } from '../../entities';

@Injectable()
export class BannersService {
  constructor(
    @InjectRepository(Banner)
    private readonly bannerRepository: Repository<Banner>,
  ) {}

  /** Banners that are switched on and inside their time window right now. */
  async findActive(now = new Date()) {
    const rows = await this.bannerRepository
      .createQueryBuilder('banner')
      .where('banner.active = true')
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('banner.startsAt IS NULL')
            .orWhere('banner.startsAt <= :now', { now }),
        ),
      )
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('banner.endsAt IS NULL')
            .orWhere('banner.endsAt > :now', { now }),
        ),
      )
      .orderBy('banner.priority', 'ASC')
      .addOrderBy('banner.id', 'ASC')
      .getMany();

    return { items: rows.map(toBannerResponse) };
  }
}

export function toBannerResponse(banner: Banner) {
  return {
    id: banner.id,
    title: banner.title,
    subtitle: banner.subtitle,
    badge: banner.badge,
    imageUrl: banner.imageUrl,
    accentColorHex: banner.accentColorHex,
    link: { type: banner.linkType, target: banner.linkTarget },
    startsAt: banner.startsAt,
    endsAt: banner.endsAt,
  };
}
