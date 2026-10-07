import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import {
  Banner,
  BannerLinkType,
  Draw,
  Gacha,
  GachaItem,
  InventoryItem,
  InventoryStatus,
  PaymentOrder,
  PaymentOrderStatus,
  ShippingRequest,
  ShippingRequestStatus,
  User,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { startOfKstMonth, toKstDateString } from '../../common/utils/kst-date';
import { summarizeEconomy } from '../gacha/gacha-economy';
import { toBannerResponse } from '../banners/banners.service';
import {
  AdminPaymentsQueryDto,
  AdminShippingQueryDto,
  SaveBannerDto,
  UpdateGachaDto,
  UpdateShippingDto,
} from './dto/admin.dto';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Next allowed shipping states, keyed by the current one. */
const SHIPPING_TRANSITIONS: Record<
  ShippingRequestStatus,
  ShippingRequestStatus[]
> = {
  [ShippingRequestStatus.REQUESTED]: [ShippingRequestStatus.SHIPPING],
  // SHIPPING → SHIPPING lets an operator correct the tracking number.
  [ShippingRequestStatus.SHIPPING]: [
    ShippingRequestStatus.SHIPPING,
    ShippingRequestStatus.DELIVERED,
  ],
  [ShippingRequestStatus.DELIVERED]: [],
};

@Injectable()
export class AdminService {
  constructor(private readonly dataSource: DataSource) {}

  // --- Dashboard ----------------------------------------------------------

  async getStats() {
    const now = new Date();
    const todayStart = new Date(
      Date.parse(`${toKstDateString(now)}T00:00:00Z`) - KST_OFFSET_MS,
    );
    const monthStart = startOfKstMonth(now);
    const q = (sql: string, params: unknown[] = []) =>
      this.dataSource.query(sql, params).then((rows) => rows[0]);

    const revenue = (since: Date | null) =>
      q(
        `SELECT COALESCE(SUM(amount), 0)::bigint AS total, COUNT(DISTINCT user_id) AS payers
           FROM payment_orders WHERE status = 'DONE' ${since ? 'AND "approvedAt" >= $1' : ''}`,
        since ? [since] : [],
      );
    const draws = (since: Date | null) =>
      q(
        `SELECT COUNT(*) AS draws, COALESCE(SUM(spent), 0)::bigint AS spent
           FROM draws ${since ? 'WHERE "createdAt" >= $1' : ''}`,
        since ? [since] : [],
      );
    const newUsers = (since: Date) =>
      q(
        `SELECT COUNT(*) AS count FROM users WHERE "createdAt" >= $1 AND "deletedAt" IS NULL`,
        [since],
      );

    const [
      revToday,
      revMonth,
      revTotal,
      drawsToday,
      drawsTotal,
      usersToday,
      usersTotal,
      gp,
      shipments,
      review,
    ] = await Promise.all([
      revenue(todayStart),
      revenue(monthStart),
      revenue(null),
      draws(todayStart),
      draws(null),
      newUsers(todayStart),
      q(`SELECT COUNT(*) AS count FROM users WHERE "deletedAt" IS NULL`),
      q(
        `SELECT COALESCE(SUM("coinBalance"), 0)::bigint AS total FROM users WHERE "deletedAt" IS NULL`,
      ),
      q(
        `SELECT COUNT(*) FILTER (WHERE status = 'REQUESTED') AS requested,
                COUNT(*) FILTER (WHERE status = 'SHIPPING') AS shipping
           FROM shipping_requests`,
      ),
      q(
        `SELECT COUNT(*) AS count FROM payment_orders
          WHERE status = 'CANCELED'
             OR (status = 'FAILED' AND "failureReason" = 'Approved payment does not match')
             OR (status = 'IN_PROGRESS' AND "updatedAt" < now() - interval '10 minutes')`,
      ),
    ]);

    const n = (v: unknown) => Number(v ?? 0);
    return {
      today: {
        revenue: n(revToday.total),
        payingUsers: n(revToday.payers),
        draws: n(drawsToday.draws),
        gpSpentOnDraws: n(drawsToday.spent),
        newUsers: n(usersToday.count),
      },
      month: { revenue: n(revMonth.total), payingUsers: n(revMonth.payers) },
      total: {
        revenue: n(revTotal.total),
        draws: n(drawsTotal.draws),
        gpSpentOnDraws: n(drawsTotal.spent),
        users: n(usersTotal.count),
        // GP users still hold: prepaid value the business owes in goods.
        gpOutstanding: n(gp.total),
      },
      actionRequired: {
        shipmentsToSend: n(shipments.requested),
        shipmentsInTransit: n(shipments.shipping),
        // Refunded after credit, charged-but-mismatched, or stuck orders.
        paymentsToReview: n(review.count),
      },
    };
  }

  // --- Shipping -----------------------------------------------------------

  async listShipping(query: AdminShippingQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 30, 100);
    const [rows, totalCount] = await this.dataSource
      .getRepository(ShippingRequest)
      .findAndCount({
        where: query.status ? { status: query.status } : {},
        relations: [
          'user',
          'items',
          'items.inventoryItem',
          'items.inventoryItem.item',
        ],
        // Oldest first: the queue an operator works through.
        order: { createdAt: 'ASC' },
        skip: (page - 1) * limit,
        take: limit,
      });
    return {
      items: rows.map((row) => ({
        shippingRequestId: row.id,
        status: row.status,
        user: {
          id: row.user.id,
          nickname: row.user.nickname,
          email: row.user.email,
        },
        recipientName: row.recipientName,
        phone: row.phone,
        address: row.address,
        notes: row.notes,
        trackingCompany: row.trackingCompany,
        trackingNumber: row.trackingNumber,
        shippedAt: row.shippedAt,
        deliveredAt: row.deliveredAt,
        createdAt: row.createdAt,
        items: row.items.map((sri) => ({
          inventoryItemId: sri.inventoryItem.id,
          name: sri.inventoryItem.item.name,
          rarity: sri.inventoryItem.item.rarity,
          estimatedValue: sri.inventoryItem.item.estimatedValue,
        })),
      })),
      page,
      limit,
      totalCount,
    };
  }

  /** REQUESTED → SHIPPING (with tracking) → DELIVERED, items follow. */
  async updateShipping(id: number, dto: UpdateShippingDto) {
    return this.dataSource.transaction(async (manager) => {
      const request = await manager
        .getRepository(ShippingRequest)
        .createQueryBuilder('sr')
        .setLock('pessimistic_write')
        .where('sr.id = :id', { id })
        .getOne();
      if (!request) throw notFound('Shipping request');

      if (!SHIPPING_TRANSITIONS[request.status].includes(dto.status)) {
        throw new BusinessException(
          ResponseCode.CONFLICT,
          `Cannot move a ${request.status} shipment to ${dto.status}`,
          HttpStatus.CONFLICT,
        );
      }
      if (dto.status === ShippingRequestStatus.SHIPPING) {
        const company = dto.trackingCompany ?? request.trackingCompany;
        const number = dto.trackingNumber ?? request.trackingNumber;
        if (!company || !number) {
          throw new BusinessException(
            ResponseCode.VALIDATION_FAILED,
            'trackingCompany and trackingNumber are required to ship',
            HttpStatus.BAD_REQUEST,
          );
        }
        request.trackingCompany = company;
        request.trackingNumber = number;
        request.shippedAt = request.shippedAt ?? new Date();
      }
      if (dto.status === ShippingRequestStatus.DELIVERED) {
        request.deliveredAt = new Date();
      }
      request.status = dto.status;
      await manager.getRepository(ShippingRequest).save(request);

      const itemIds: number[] = (
        await manager.query(
          `SELECT inventory_item_id AS id FROM shipping_request_items WHERE shipping_request_id = $1`,
          [id],
        )
      ).map((r: { id: number }) => r.id);
      await manager.getRepository(InventoryItem).update(
        { id: In(itemIds) },
        {
          status:
            dto.status === ShippingRequestStatus.DELIVERED
              ? InventoryStatus.DELIVERED
              : InventoryStatus.SHIPPING,
        },
      );
      return {
        shippingRequestId: request.id,
        status: request.status,
        trackingCompany: request.trackingCompany,
        trackingNumber: request.trackingNumber,
        shippedAt: request.shippedAt,
        deliveredAt: request.deliveredAt,
      };
    });
  }

  // --- Boxes --------------------------------------------------------------

  async listGachas() {
    const gachas = await this.dataSource
      .getRepository(Gacha)
      .find({ order: { active: 'DESC', id: 'ASC' } });
    const pools = await this.dataSource.getRepository(GachaItem).find({
      where: { gachaId: In(gachas.map((g) => g.id)) },
      relations: ['item'],
    });
    return {
      items: gachas.map((gacha) => {
        const entries = pools
          .filter((p) => p.gachaId === gacha.id)
          .map((p) => ({
            rarity: p.item.rarity,
            weight: p.weight,
            estimatedValue: p.item.estimatedValue,
          }));
        const economy = summarizeEconomy(
          entries,
          gacha.price,
          gacha.pityThreshold,
        );
        return {
          id: gacha.id,
          title: gacha.title,
          active: gacha.active,
          price: gacha.price,
          totalStock: gacha.totalStock,
          soldCount: gacha.soldCount,
          soldOut: gacha.soldCount >= gacha.totalStock,
          revenueGp: gacha.soldCount * gacha.price,
          pityThreshold: gacha.pityThreshold,
          itemCount: entries.length,
          payoutRatioPercent: {
            singleDraw: Math.round(economy.payoutRatio * 1000) / 10,
            multiDraw: Math.round(economy.multiDrawPayoutRatio * 1000) / 10,
          },
        };
      }),
    };
  }

  /** Put a box on/off sale or resize its round (never below what sold). */
  async updateGacha(id: number, dto: UpdateGachaDto) {
    return this.dataSource.transaction(async (manager) => {
      const gacha = await manager
        .getRepository(Gacha)
        .createQueryBuilder('g')
        .setLock('pessimistic_write')
        .where('g.id = :id', { id })
        .getOne();
      if (!gacha) throw notFound('Gacha');
      if (dto.totalStock !== undefined) {
        if (dto.totalStock < gacha.soldCount) {
          throw new BusinessException(
            ResponseCode.VALIDATION_FAILED,
            `totalStock cannot be below the ${gacha.soldCount} already sold`,
            HttpStatus.BAD_REQUEST,
          );
        }
        gacha.totalStock = dto.totalStock;
      }
      if (dto.active !== undefined) gacha.active = dto.active;
      await manager.getRepository(Gacha).save(gacha);
      return {
        id: gacha.id,
        active: gacha.active,
        totalStock: gacha.totalStock,
        soldCount: gacha.soldCount,
      };
    });
  }

  // --- Banners ------------------------------------------------------------

  async listBanners() {
    const rows = await this.dataSource
      .getRepository(Banner)
      .find({ order: { priority: 'ASC', id: 'ASC' } });
    return {
      items: rows.map((b) => ({
        ...toBannerResponse(b),
        active: b.active,
        priority: b.priority,
      })),
    };
  }

  async createBanner(dto: SaveBannerDto) {
    if (!dto.title) {
      throw new BusinessException(
        ResponseCode.VALIDATION_FAILED,
        'title is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    const repo = this.dataSource.getRepository(Banner);
    const banner = repo.create();
    await this.applyBanner(banner, dto);
    return toBannerResponse(await repo.save(banner));
  }

  async updateBanner(id: number, dto: SaveBannerDto) {
    const repo = this.dataSource.getRepository(Banner);
    const banner = await repo.findOne({ where: { id } });
    if (!banner) throw notFound('Banner');
    await this.applyBanner(banner, dto);
    return toBannerResponse(await repo.save(banner));
  }

  private async applyBanner(banner: Banner, dto: SaveBannerDto) {
    const { startsAt, endsAt, ...rest } = dto;
    Object.assign(
      banner,
      Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      ),
    );
    if (startsAt !== undefined)
      banner.startsAt = startsAt ? new Date(startsAt) : null;
    if (endsAt !== undefined) banner.endsAt = endsAt ? new Date(endsAt) : null;

    // A banner must point at something that exists.
    const target = banner.linkTarget;
    const needsBox =
      banner.linkType === BannerLinkType.GACHA ||
      (banner.linkType === BannerLinkType.ODDS && target);
    if (needsBox) {
      const exists =
        !!target &&
        /^\d+$/.test(target) &&
        (await this.dataSource
          .getRepository(Gacha)
          .exists({ where: { id: Number(target) } }));
      if (!exists) throw invalidLink('linkTarget must be an existing box id');
    }
    if (
      banner.linkType === BannerLinkType.URL &&
      !(target && target.startsWith('https://'))
    ) {
      throw invalidLink('linkTarget must be an https URL');
    }
    if (banner.startsAt && banner.endsAt && banner.endsAt <= banner.startsAt) {
      throw invalidLink('endsAt must be after startsAt');
    }
  }

  // --- Payments -----------------------------------------------------------

  async listPayments(query: AdminPaymentsQueryDto) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 30, 100);
    const [rows, totalCount] = await this.dataSource
      .getRepository(PaymentOrder)
      .findAndCount({
        where: query.status
          ? { status: query.status }
          : {
              status: In(
                Object.values(PaymentOrderStatus).filter((s) => s !== 'READY'),
              ),
            },
        relations: ['user'],
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });
    return {
      items: rows.map((o) => ({
        orderId: o.orderId,
        status: o.status,
        user: { id: o.user.id, nickname: o.user.nickname },
        amount: o.amount,
        totalGp: o.gp + o.bonusGp + o.firstTopupBonusGp,
        method: o.method,
        paymentKey: o.paymentKey,
        failureReason: o.failureReason,
        approvedAt: o.approvedAt,
        createdAt: o.createdAt,
      })),
      page,
      limit,
      totalCount,
    };
  }

  /** Users list for support lookups. */
  async findUsers(search: string | undefined) {
    const qb = this.dataSource
      .getRepository(User)
      .createQueryBuilder('u')
      .where('u.deletedAt IS NULL')
      .orderBy('u.id', 'DESC')
      .take(50);
    if (search) {
      qb.andWhere('(u.email ILIKE :s OR u.nickname ILIKE :s)', {
        s: `%${search.replace(/[%_]/g, '\\$&')}%`,
      });
    }
    const users = await qb.getMany();
    const drawCounts = await this.dataSource
      .getRepository(Draw)
      .createQueryBuilder('d')
      .select('d.userId', 'userId')
      .addSelect('COUNT(*)', 'count')
      .where({ userId: In(users.map((u) => u.id).concat(0)) })
      .groupBy('d.userId')
      .getRawMany<{ userId: number; count: string }>();
    const countOf = new Map(
      drawCounts.map((r) => [Number(r.userId), Number(r.count)]),
    );
    return {
      items: users.map((u) => ({
        id: u.id,
        email: u.email,
        nickname: u.nickname,
        provider: u.provider,
        role: u.role,
        coinBalance: Number(u.coinBalance),
        monthlyTopupLimit: u.monthlyTopupLimit,
        drawCount: countOf.get(u.id) ?? 0,
        createdAt: u.createdAt,
      })),
    };
  }
}

function notFound(what: string) {
  return new BusinessException(
    ResponseCode.NOT_FOUND,
    `${what} not found`,
    HttpStatus.NOT_FOUND,
  );
}

function invalidLink(message: string) {
  return new BusinessException(
    ResponseCode.VALIDATION_FAILED,
    message,
    HttpStatus.BAD_REQUEST,
  );
}
