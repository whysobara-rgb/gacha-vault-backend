import {
  loadProbability,
  probabilityVersion,
  selectPrize,
} from './probability';
import { Injectable } from '@nestjs/common';
import { randomUUID, randomInt } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  CapsuleOrder,
  CapsuleOpening,
  InventoryItem,
  InventoryStatus,
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
      typeof dto.expectedProbabilityVersion !== 'string' ||
      !/^[a-f0-9]{64}$/.test(dto.expectedProbabilityVersion) ||
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
          existing.unitPrice !== dto.expectedUnitPrice ||
          existing.probabilityVersion !== dto.expectedProbabilityVersion
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
      const probability = await loadProbability(manager, gacha.id);
      if (probability.version !== dto.expectedProbabilityVersion)
        throw fail('확률·상품 정보가 변경되었습니다. 다시 확인해 주세요');
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
          probabilitySnapshot: probability.snapshot,
          probabilityVersion: probability.version,
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
      await manager.query(
        'INSERT INTO order_prize_refs(order_id, item_id) SELECT $1::uuid, unnest($2::integer[])',
        [orderId, probability.snapshot.entries.map((entry) => entry.itemId)],
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
      probabilityVersion: order.probabilityVersion,
      probabilitySnapshot: order.probabilitySnapshot,
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
      .andWhere("capsule.status = 'UNOPENED'")
      .orderBy('capsule.createdAt', 'DESC')
      .addOrderBy('capsule.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return { items, totalCount, page: query.page, limit: query.limit };
  }
  async odds(gachaId: number) {
    const gacha = await this.database
      .getRepository(Gacha)
      .findOneBy({ id: gachaId, active: true });
    if (!gacha) throw fail('판매 중인 캡슐을 찾을 수 없습니다', 404);
    const probability = await loadProbability(this.database.manager, gachaId);
    return {
      gachaId,
      unitPrice: gacha.price,
      currency: gacha.currency,
      ...probability,
    };
  }

  private result(result: CapsuleOpening) {
    return {
      capsuleId: result.capsuleId,
      inventoryItemId: result.inventoryItemId,
      probabilityVersion: result.probabilityVersion,
      prize: result.prize,
      openedAt: result.openedAt,
    };
  }

  async openingResult(userId: number, capsuleId: string) {
    const owned = await this.database
      .getRepository(OwnedCapsule)
      .createQueryBuilder('capsule')
      .innerJoin(CapsuleOrder, 'order', 'order.id = capsule.orderId')
      .where('capsule.id = :capsuleId AND order.userId = :userId', {
        capsuleId,
        userId,
      })
      .getOne();
    if (!owned) throw fail('캡슐을 찾을 수 없습니다', 404);
    const result = await this.database
      .getRepository(CapsuleOpening)
      .findOneBy({ capsuleId });
    if (!result) throw fail('아직 개봉하지 않은 캡슐입니다');
    return this.result(result);
  }

  async open(userId: number, capsuleId: string) {
    if (
      !['development', 'test'].includes(process.env.NODE_ENV ?? '') ||
      process.env.ENABLE_GP_ORDER_PREVIEW !== 'true' ||
      process.env.ENABLE_LEGACY_TRANSACTIONS === 'true'
    )
      throw new BusinessException(
        ResponseCode.FORBIDDEN,
        '개봉 기능은 검증 중입니다',
        503,
      );
    if (
      !Number.isSafeInteger(userId) ||
      userId < 1 ||
      typeof capsuleId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        capsuleId,
      )
    )
      throw fail('개봉 요청이 올바르지 않습니다', 400);
    capsuleId = capsuleId.toLowerCase();
    return this.database.transaction(async (manager) => {
      // Same user-first order as purchases; later refunds must share this order.
      const user = await manager
        .getRepository(User)
        .createQueryBuilder('user')
        .setLock('pessimistic_write')
        .where('user.id = :userId', { userId })
        .getOne();
      if (!user) throw fail('계정을 찾을 수 없습니다', 404);
      const capsule = await manager
        .getRepository(OwnedCapsule)
        .createQueryBuilder('capsule')
        .innerJoin(CapsuleOrder, 'order', 'order.id = capsule.orderId')
        .setLock('pessimistic_write', undefined, ['capsule'])
        .where('capsule.id = :capsuleId AND order.userId = :userId', {
          capsuleId,
          userId,
        })
        .getOne();
      if (!capsule) throw fail('캡슐을 찾을 수 없습니다', 404);
      const results = manager.getRepository(CapsuleOpening);
      const previous = await results.findOneBy({ capsuleId });
      if (previous && capsule.status === 'OPENED') return this.result(previous);
      if (previous || capsule.status !== 'UNOPENED')
        throw fail('캡슐 상태 확인이 필요합니다');
      const order = await manager
        .getRepository(CapsuleOrder)
        .findOneByOrFail({ id: capsule.orderId, userId });
      if (
        order.status !== 'PAID' ||
        !order.probabilitySnapshot ||
        !order.probabilityVersion ||
        probabilityVersion(order.probabilitySnapshot) !==
          order.probabilityVersion
      )
        throw fail('구매 당시 확률 정보를 확인할 수 없습니다');
      const ticket = randomInt(1000000);
      const prize = selectPrize(order.probabilitySnapshot, ticket);
      const inventory = await manager.getRepository(InventoryItem).save({
        userId,
        itemId: prize.itemId,
        status: InventoryStatus.STORED,
        isLocked: false,
      });
      const result = await results.save(
        results.create({
          capsuleId,
          inventoryItemId: inventory.id,
          probabilityVersion: order.probabilityVersion,
          prize,
          ticket,
        }),
      );
      await manager
        .getRepository(OwnedCapsule)
        .update(capsule.id, { status: 'OPENED' });
      return this.result(result);
    });
  }
}
