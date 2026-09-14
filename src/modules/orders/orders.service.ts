import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  CapsuleOrder,
  OwnedCapsule,
  User,
  Gacha,
  CurrencyType,
  Draw,
  WalletTransaction,
  WalletTransactionType,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { CreateGpOrderDto, ListCapsulesDto } from './order.dto';

const fail = (message: string, status = 409) =>
  new BusinessException(
    status === 404
      ? ResponseCode.NOT_FOUND
      : status === 400
        ? ResponseCode.VALIDATION_FAILED
        : ResponseCode.CONFLICT,
    message,
    status,
  );

@Injectable()
export class OrdersService {
  constructor(private readonly database: DataSource) {}

  async purchase(userId: number, key: string, dto: CreateGpOrderDto) {
    // GP provenance, probability snapshots and real payment settlement are not
    // ready. Never enable this foundation in production by setting a flag.
    if (
      !['development', 'test'].includes(process.env.NODE_ENV ?? '') ||
      process.env.ENABLE_GP_ORDER_PREVIEW !== 'true' ||
      process.env.ENABLE_LEGACY_TRANSACTIONS === 'true'
    ) {
      throw new BusinessException(
        ResponseCode.FORBIDDEN,
        '주문 기능은 검증 중입니다',
        503,
      );
    }
    if (
      !Number.isSafeInteger(userId) ||
      userId < 1 ||
      typeof key !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        key,
      ) ||
      !dto ||
      !Number.isInteger(dto.gachaId) ||
      dto.gachaId < 1 ||
      dto.gachaId > 2147483647 ||
      !Number.isInteger(dto.quantity) ||
      dto.quantity < 1 ||
      dto.quantity > 100 ||
      !Number.isInteger(dto.expectedUnitPrice) ||
      dto.expectedUnitPrice < 1 ||
      dto.expectedUnitPrice > 2147483647
    ) {
      throw fail('주문 요청이 올바르지 않습니다', 400);
    }
    return this.database.transaction(async (manager) => {
      // Consistent lock order: user then gacha. All GP writers must share the
      // user row lock; legacy writes are disabled while this preview is active.
      const user = await manager
        .getRepository(User)
        .createQueryBuilder('user')
        .setLock('pessimistic_write')
        .where('user.id = :userId', { userId })
        .getOne();
      if (!user) throw fail('계정을 찾을 수 없습니다', 404);
      const orders = manager.getRepository(CapsuleOrder);
      const existing = await orders.findOneBy({
        userId,
        idempotencyKey: key.toLowerCase(),
      });
      if (existing) {
        if (
          existing.gachaId !== dto.gachaId ||
          existing.quantity !== dto.quantity ||
          existing.unitPrice !== dto.expectedUnitPrice
        )
          throw fail('같은 요청 키를 다른 주문에 사용할 수 없습니다');
        return this.receipt(manager, existing);
      }
      const gacha = await manager
        .getRepository(Gacha)
        .createQueryBuilder('gacha')
        .setLock('pessimistic_write')
        .where('gacha.id = :id', { id: dto.gachaId })
        .getOne();
      if (!gacha || !gacha.active)
        throw fail('판매 중인 캡슐을 찾을 수 없습니다', 404);
      if (gacha.currency !== CurrencyType.GP)
        throw fail('GP 전용 상품만 구매할 수 있습니다');
      if (
        !Number.isInteger(gacha.price) ||
        gacha.price <= 0 ||
        gacha.price !== dto.expectedUnitPrice
      )
        throw fail('가격이 변경되었습니다. 다시 확인해 주세요');
      const total = gacha.price * dto.quantity;
      if (!Number.isSafeInteger(total) || total > 2147483647)
        throw fail('주문 금액 한도를 초과했습니다', 400);
      const [{ sold }] = await manager.query(
        'SELECT COALESCE(sum(quantity), 0) AS sold FROM capsule_orders WHERE gacha_id = $1',
        [gacha.id],
      );
      const legacySold = await manager
        .getRepository(Draw)
        .countBy({ gachaId: gacha.id });
      if (
        !Number.isInteger(gacha.totalStock) ||
        BigInt(sold) + BigInt(legacySold) + BigInt(dto.quantity) >
          BigInt(gacha.totalStock)
      )
        throw fail('남은 수량이 부족합니다');
      const balance = BigInt(user.coinBalance);
      if (balance < BigInt(total))
        throw new BusinessException(
          ResponseCode.INSUFFICIENT_BALANCE,
          'GP가 부족합니다',
          409,
        );
      // Existing User entity uses JS numbers; reject values it cannot represent.
      if (balance > BigInt(Number.MAX_SAFE_INTEGER))
        throw fail('잔액 확인이 필요합니다');
      const balanceAfter = balance - BigInt(total);
      await manager
        .getRepository(User)
        .update(user.id, { coinBalance: Number(balanceAfter) });
      const orderId = randomUUID();
      const wallet = await manager.getRepository(WalletTransaction).save({
        userId,
        type: WalletTransactionType.USE,
        amount: -total,
        description: `GP 캡슐 주문 ${orderId}`,
        balanceAfter: Number(balanceAfter),
      });
      const order = await orders.save(
        orders.create({
          id: orderId,
          userId,
          idempotencyKey: key.toLowerCase(),
          gachaId: gacha.id,
          titleSnapshot: gacha.title,
          unitPrice: gacha.price,
          quantity: dto.quantity,
          total,
          currency: 'GP',
          status: 'PAID',
          walletTransactionId: wallet.id,
          balanceAfter: balanceAfter.toString(),
        }),
      );
      await manager.getRepository(OwnedCapsule).insert(
        Array.from({ length: dto.quantity }, (_, i) => ({
          id: randomUUID(),
          orderId,
          sequence: i + 1,
          status: 'UNOPENED',
        })),
      );
      return this.receipt(manager, order);
    });
  }

  private async receipt(manager: EntityManager, order: CapsuleOrder) {
    const capsules = await manager.getRepository(OwnedCapsule).find({
      where: { orderId: order.id },
      order: { sequence: 'ASC' },
    });
    return {
      orderId: order.id,
      gachaId: order.gachaId,
      title: order.titleSnapshot,
      quantity: order.quantity,
      unitPrice: order.unitPrice,
      total: order.total,
      currency: order.currency,
      status: order.status,
      balanceAfter: order.balanceAfter,
      createdAt: order.createdAt,
      capsules,
    };
  }

  async findOne(userId: number, id: string) {
    const order = await this.database
      .getRepository(CapsuleOrder)
      .findOneBy({ id, userId });
    if (!order) throw fail('주문을 찾을 수 없습니다', 404);
    return this.receipt(this.database.manager, order);
  }

  async listCapsules(userId: number, query: ListCapsulesDto) {
    const [items, totalCount] = await this.database
      .getRepository(OwnedCapsule)
      .createQueryBuilder('capsule')
      .innerJoin(CapsuleOrder, 'order', 'order.id = capsule.orderId')
      .where('order.userId = :userId', { userId })
      .orderBy('capsule.createdAt', 'DESC')
      .addOrderBy('capsule.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return { items, totalCount, page: query.page, limit: query.limit };
  }
}
