import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  PaymentOrder,
  PaymentOrderStatus,
  User,
  WalletTransaction,
  WalletTransactionReason,
  WalletTransactionType,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import {
  FIRST_TOPUP_BONUS,
  TOPUP_PACKAGES,
} from '../../common/constants/economy.constant';
import { WalletService } from '../wallet/wallet.service';
import {
  TossDeclinedError,
  TossPayment,
  TossPaymentsClient,
  TossUnavailableError,
} from './toss-payments.client';
import { ConfirmPaymentDto, CreatePaymentOrderDto } from './dto/payment.dto';

const FAILED_PAYMENT_STATUSES = ['CANCELED', 'ABORTED', 'EXPIRED'];

export function firstTopupBonusFor(gp: number): number {
  return Math.min(
    Math.floor(gp * FIRST_TOPUP_BONUS.rate),
    FIRST_TOPUP_BONUS.maxGp,
  );
}

/**
 * GP top-ups through Toss Payments.
 *
 *   1. POST /payments/orders   — creates a READY order for a package; the
 *      app opens the Toss widget with its orderId and amount.
 *   2. POST /payments/confirm  — after the widget succeeds. The amount must
 *      match our order; the order moves to IN_PROGRESS, Toss approves it,
 *      and GP is credited once (DONE).
 *   3. If the approval outcome is unknown (timeout, our crash), the order
 *      stays IN_PROGRESS. Calling confirm again, or Toss's webhook, looks
 *      the payment up with Toss and finishes it. GP is never credited
 *      from client- or webhook-supplied data alone.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly toss: TossPaymentsClient,
    private readonly wallet: WalletService,
    private readonly config: ConfigService,
  ) {}

  async getConfig(userId: number) {
    const firstTopupEligible = !(await this.hasCompletedPayment(
      this.dataSource.manager,
      userId,
    ));
    return {
      enabled: this.toss.enabled,
      clientKey: this.toss.clientKey ?? null,
      customerKey: this.customerKey(userId),
      packages: TOPUP_PACKAGES.map((pkg) => ({
        ...pkg,
        firstTopupBonusGp: firstTopupEligible ? firstTopupBonusFor(pkg.gp) : 0,
      })),
      firstTopupBonus: { ...FIRST_TOPUP_BONUS, eligible: firstTopupEligible },
    };
  }

  async createOrder(userId: number, dto: CreatePaymentOrderDto) {
    this.ensureEnabled();
    const pkg = TOPUP_PACKAGES.find((p) => p.id === dto.packageId);
    if (!pkg) {
      throw new BusinessException(
        ResponseCode.VALIDATION_FAILED,
        'Unknown package',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const user = await this.wallet.lockUser(manager, userId);
      await this.wallet.assertTopupAllowed(manager, user, pkg.price);

      const order = await manager.getRepository(PaymentOrder).save(
        manager.getRepository(PaymentOrder).create({
          orderId: `GV${randomUUID().replace(/-/g, '')}`,
          userId,
          packageId: pkg.id,
          amount: pkg.price,
          gp: pkg.gp,
          bonusGp: pkg.bonusGp,
        }),
      );
      const firstBonus = (await this.hasCompletedPayment(manager, userId))
        ? 0
        : firstTopupBonusFor(pkg.gp);
      return {
        orderId: order.orderId,
        orderName: `가치가차 ${pkg.gp.toLocaleString('ko-KR')} GP`,
        amount: order.amount,
        gp: order.gp,
        bonusGp: order.bonusGp,
        firstTopupBonusGp: firstBonus,
        clientKey: this.toss.clientKey,
        customerKey: this.customerKey(userId),
      };
    });
  }

  async confirm(userId: number, dto: ConfirmPaymentDto) {
    this.ensureEnabled();
    const orders = this.dataSource.getRepository(PaymentOrder);
    const order = await orders.findOne({
      where: { orderId: dto.orderId, userId },
    });
    if (!order) {
      throw new BusinessException(
        ResponseCode.NOT_FOUND,
        'Order not found',
        HttpStatus.NOT_FOUND,
      );
    }

    if (order.status === PaymentOrderStatus.DONE) {
      if (order.paymentKey !== dto.paymentKey) throw conflict(order);
      return this.describe(order); // repeated confirm: already credited
    }
    if (
      order.status === PaymentOrderStatus.FAILED ||
      order.status === PaymentOrderStatus.CANCELED
    ) {
      throw conflict(order);
    }
    if (dto.amount !== order.amount) {
      if (order.status === PaymentOrderStatus.READY) {
        await this.fail(order.id, 'Amount does not match the order');
      }
      throw paymentFailed('Amount does not match the order');
    }

    let payment: TossPayment;
    if (order.status === PaymentOrderStatus.READY) {
      await this.claim(order, dto.paymentKey);
      try {
        payment = await this.toss.confirm(
          dto.paymentKey,
          order.orderId,
          order.amount,
        );
      } catch (err) {
        if (err instanceof TossDeclinedError) {
          await this.fail(order.id, `${err.code}: ${err.message}`);
          throw paymentFailed(err.message, [`code:${err.code}`]);
        }
        throw pending(err);
      }
    } else {
      // IN_PROGRESS: an earlier confirm didn't finish; ask Toss.
      if (order.paymentKey !== dto.paymentKey) throw conflict(order);
      try {
        payment = await this.toss.getPayment(dto.paymentKey);
      } catch (err) {
        throw pending(err);
      }
    }
    return this.finalize(order.id, payment);
  }

  /**
   * Toss webhook (PAYMENT_STATUS_CHANGED). The body is only a hint: the
   * payment is re-read from Toss with our secret key before acting on it.
   */
  async handleWebhook(body: any) {
    const paymentKey: unknown = body?.data?.paymentKey;
    if (typeof paymentKey !== 'string') return { received: true };
    const order = await this.dataSource
      .getRepository(PaymentOrder)
      .findOne({ where: { paymentKey } });
    if (!order) return { received: true };

    let payment: TossPayment;
    try {
      payment = await this.toss.getPayment(paymentKey);
    } catch (err) {
      // Non-2xx makes Toss retry later.
      throw pending(err);
    }

    if (order.status === PaymentOrderStatus.IN_PROGRESS) {
      await this.finalize(order.id, payment).catch((err) =>
        this.logger.warn(`webhook finalize ${order.orderId}: ${err.message}`),
      );
    } else if (
      order.status === PaymentOrderStatus.DONE &&
      payment.status.endsWith('CANCELED')
    ) {
      // Refunded on the Toss side. GP is not clawed back automatically:
      // it may already be spent, so an operator settles it.
      await this.dataSource
        .getRepository(PaymentOrder)
        .update(order.id, { status: PaymentOrderStatus.CANCELED });
      this.logger.warn(`payment ${order.orderId} canceled after credit`);
    }
    return { received: true };
  }

  async listMine(userId: number) {
    const rows = await this.dataSource.getRepository(PaymentOrder).find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return {
      items: rows
        .filter((row) => row.status !== PaymentOrderStatus.READY)
        .map((row) => this.describeRow(row)),
    };
  }

  /** READY → IN_PROGRESS exactly once, re-checking the top-up limit. */
  private async claim(order: PaymentOrder, paymentKey: string) {
    await this.dataSource.transaction(async (manager) => {
      const user = await this.wallet.lockUser(manager, order.userId);
      await this.wallet.assertTopupAllowed(manager, user, order.amount);
      const claimed = await manager
        .getRepository(PaymentOrder)
        .createQueryBuilder()
        .update(PaymentOrder)
        .set({ status: PaymentOrderStatus.IN_PROGRESS, paymentKey })
        .where('id = :id AND status = :ready', {
          id: order.id,
          ready: PaymentOrderStatus.READY,
        })
        .execute();
      if (!claimed.affected) throw conflict(order);
    });
  }

  /**
   * Credits GP for an approved payment; safe to call more than once. A
   * failure is recorded after the transaction, since throwing inside it
   * would roll the FAILED status back too.
   */
  private async finalize(orderPk: number, payment: TossPayment) {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const peek = await manager
        .getRepository(PaymentOrder)
        .findOneByOrFail({ id: orderPk });
      // Lock order: user row, then order row (same as claim()).
      const user = await this.wallet.lockUser(manager, peek.userId);
      const order = await manager
        .getRepository(PaymentOrder)
        .createQueryBuilder('o')
        .setLock('pessimistic_write')
        .where('o.id = :id', { id: orderPk })
        .getOneOrFail();

      if (order.status === PaymentOrderStatus.DONE) {
        return { done: await this.describe(order, user) };
      }
      if (FAILED_PAYMENT_STATUSES.includes(payment.status)) {
        return {
          failure: `Toss status ${payment.status}`,
          message: `Payment ${payment.status.toLowerCase()}`,
        };
      }
      if (payment.status !== 'DONE') {
        throw pending(new Error(`Toss status ${payment.status}`));
      }
      if (
        payment.orderId !== order.orderId ||
        payment.totalAmount !== order.amount
      ) {
        // Charged but not what we sold: never credit, flag for an operator.
        this.logger.error(
          `payment mismatch for ${order.orderId}: ${JSON.stringify(payment)}`,
        );
        return {
          failure: 'Approved payment does not match',
          message: 'Approved payment does not match the order',
        };
      }

      const firstBonus = (await this.hasCompletedPayment(manager, user.id))
        ? 0
        : firstTopupBonusFor(order.gp);
      const ledger = manager.getRepository(WalletTransaction);
      let balance = Number(user.coinBalance);
      const credit = async (
        amount: number,
        reason: WalletTransactionReason,
        description: string,
      ) => {
        if (amount <= 0) return;
        balance += amount;
        await ledger.save(
          ledger.create({
            userId: user.id,
            type: WalletTransactionType.EARN,
            reason,
            amount,
            description,
            balanceAfter: balance,
          }),
        );
      };
      await credit(
        order.gp,
        WalletTransactionReason.TOPUP,
        `GP 충전 (${order.amount.toLocaleString('ko-KR')}원 결제)`,
      );
      await credit(
        order.bonusGp,
        WalletTransactionReason.BONUS,
        '대량 충전 보너스',
      );
      await credit(firstBonus, WalletTransactionReason.BONUS, '첫 충전 보너스');

      user.coinBalance = balance;
      await manager.getRepository(User).save(user);

      Object.assign(order, {
        status: PaymentOrderStatus.DONE,
        method: payment.method,
        approvedAt: payment.approvedAt
          ? new Date(payment.approvedAt)
          : new Date(),
        firstTopupBonusGp: firstBonus,
      });
      await manager.getRepository(PaymentOrder).save(order);
      return { done: await this.describe(order, user) };
    });

    if ('failure' in outcome) {
      await this.fail(orderPk, outcome.failure);
      throw paymentFailed(outcome.message);
    }
    return outcome.done;
  }

  private async fail(orderPk: number, reason: string) {
    await this.dataSource.getRepository(PaymentOrder).update(orderPk, {
      status: PaymentOrderStatus.FAILED,
      failureReason: reason.slice(0, 500),
    });
  }

  private hasCompletedPayment(manager: EntityManager, userId: number) {
    return manager.getRepository(PaymentOrder).exists({
      where: { userId, status: PaymentOrderStatus.DONE },
    });
  }

  private async describe(order: PaymentOrder, user?: User) {
    const balance = user
      ? Number(user.coinBalance)
      : Number(
          (
            await this.dataSource
              .getRepository(User)
              .findOneByOrFail({ id: order.userId })
          ).coinBalance,
        );
    return { ...this.describeRow(order), balanceAfter: balance };
  }

  private describeRow(order: PaymentOrder) {
    return {
      orderId: order.orderId,
      status: order.status,
      packageId: order.packageId,
      amount: order.amount,
      gp: order.gp,
      bonusGp: order.bonusGp,
      firstTopupBonusGp: order.firstTopupBonusGp,
      totalGp: order.gp + order.bonusGp + order.firstTopupBonusGp,
      method: order.method,
      approvedAt: order.approvedAt,
      createdAt: order.createdAt,
    };
  }

  /** Stable per-user key for the Toss widget; not guessable from the id. */
  private customerKey(userId: number): string {
    const secret = this.config.get<string>('TOSS_SECRET_KEY') ?? 'dev';
    return `GVC_${createHmac('sha256', secret).update(String(userId)).digest('hex').slice(0, 40)}`;
  }

  private ensureEnabled() {
    if (!this.toss.enabled) {
      throw new BusinessException(
        ResponseCode.PAYMENT_UNAVAILABLE,
        'Payments are not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}

function paymentFailed(message: string, errors: string[] = []) {
  return new BusinessException(
    ResponseCode.PAYMENT_FAILED,
    message,
    HttpStatus.BAD_REQUEST,
    errors,
  );
}

/** Outcome unknown for now; the client may retry confirm with the same data. */
function pending(err: unknown) {
  return new BusinessException(
    ResponseCode.PAYMENT_UNAVAILABLE,
    'Payment is still being confirmed; retry shortly',
    HttpStatus.SERVICE_UNAVAILABLE,
    [err instanceof TossUnavailableError ? 'toss:unavailable' : 'toss:pending'],
  );
}

function conflict(order: PaymentOrder) {
  return new BusinessException(
    ResponseCode.CONFLICT,
    `Order is ${order.status}`,
    HttpStatus.CONFLICT,
    [`status:${order.status}`],
  );
}
