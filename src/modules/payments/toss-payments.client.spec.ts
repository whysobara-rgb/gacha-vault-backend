import { ConfigService } from '@nestjs/config';
import {
  TossDeclinedError,
  TossPaymentsClient,
  TossUnavailableError,
} from './toss-payments.client';
import { firstTopupBonusFor } from './payments.service';

function client(respond: (url: string, init: RequestInit) => Response) {
  const toss = new TossPaymentsClient(
    new ConfigService({
      TOSS_CLIENT_KEY: 'test_ck_x',
      TOSS_SECRET_KEY: 'test_sk_x',
    }),
  );
  toss.useFetch((async (url: string, init: RequestInit) =>
    respond(String(url), init)) as typeof fetch);
  return toss;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe('TossPaymentsClient', () => {
  it('confirms with Basic auth and an idempotency key', async () => {
    let seen: RequestInit | undefined;
    const toss = client((url, init) => {
      seen = init;
      expect(url).toBe('https://api.tosspayments.com/v1/payments/confirm');
      return json(200, {
        paymentKey: 'pk',
        orderId: 'GV1',
        status: 'DONE',
        totalAmount: 30000,
        method: '카드',
        approvedAt: '2026-10-07T00:00:00+09:00',
      });
    });
    await expect(toss.confirm('pk', 'GV1', 30000)).resolves.toMatchObject({
      status: 'DONE',
      totalAmount: 30000,
    });
    const headers = seen!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('test_sk_x:').toString('base64')}`,
    );
    expect(headers['Idempotency-Key']).toBe('confirm-GV1');
  });

  it('treats a 4xx as a decline with the Toss code', async () => {
    const toss = client(() =>
      json(400, { code: 'REJECT_CARD_PAYMENT', message: '거절' }),
    );
    await expect(toss.confirm('pk', 'GV1', 1)).rejects.toMatchObject({
      code: 'REJECT_CARD_PAYMENT',
    });
    await expect(toss.confirm('pk', 'GV1', 1)).rejects.toBeInstanceOf(
      TossDeclinedError,
    );
  });

  it('treats 5xx and network failures as an unknown outcome', async () => {
    await expect(
      client(() => json(502, {})).confirm('pk', 'GV1', 1),
    ).rejects.toBeInstanceOf(TossUnavailableError);
    await expect(
      client(() => {
        throw new Error('socket hang up');
      }).getPayment('pk'),
    ).rejects.toBeInstanceOf(TossUnavailableError);
  });

  it('is disabled without both keys', () => {
    expect(new TossPaymentsClient(new ConfigService({})).enabled).toBe(false);
  });
});

describe('first top-up bonus', () => {
  it('is 20% of the purchased GP, capped at 10,000', () => {
    expect(firstTopupBonusFor(5000)).toBe(1000);
    expect(firstTopupBonusFor(30000)).toBe(6000);
    expect(firstTopupBonusFor(300000)).toBe(10000);
  });
});
