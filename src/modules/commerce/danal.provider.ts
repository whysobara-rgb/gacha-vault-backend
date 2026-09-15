import { Injectable } from '@nestjs/common';
import { conversionError as fail } from '../conversions/conversion.policy';
import { preview } from './commerce.policy';
// Direct ONE API contract, checked against Danal's official documentation.
// One request per persisted operation; an uncertain response is NEVER retried here.
export const DANAL_ORIGIN = 'https://one-api.danalpay.com';
export function danalConfig() {
  const e = process.env;
  if (
    !preview() ||
    e.ENABLE_DANAL_TEST_PAYMENTS !== 'true' ||
    !/^SK_TEST_[A-Za-z0-9_=-]+$/.test(e.DANAL_SECRET_KEY ?? '') ||
    !/^CL_TEST_[A-Za-z0-9_=-]+$/.test(e.DANAL_CLIENT_KEY ?? '') ||
    !/^[-A-Za-z0-9]{1,20}$/.test(e.DANAL_MERCHANT_ID ?? '')
  )
    throw fail('다날 테스트 결제 설정이 필요합니다', 503);
  return {
    secret: e.DANAL_SECRET_KEY!,
    clientKey: e.DANAL_CLIENT_KEY!,
    merchantId: e.DANAL_MERCHANT_ID!,
  };
}
export type ProviderResult = {
  confirmed: boolean;
  transactionId?: string;
  code?: string;
};
@Injectable()
export class DanalProvider {
  ready() {
    try {
      danalConfig();
      return true;
    } catch {
      return false;
    }
  }
  config() {
    const c = danalConfig();
    return { clientKey: c.clientKey, merchantId: c.merchantId };
  }
  private async post(
    path: 'confirm' | 'cancel',
    body: Record<string, unknown>,
  ): Promise<ProviderResult> {
    const c = danalConfig();
    if (body.merchantId !== c.merchantId)
      throw fail('결제 상점 설정이 변경되었습니다', 503);
    const ctrl = new AbortController(),
      timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(DANAL_ORIGIN + '/payments/' + path, {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' + Buffer.from(c.secret + ':').toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: ctrl.signal,
      });
      const text = await r.text();
      if (text.length > 65536) return { confirmed: false };
      const data = JSON.parse(text);
      if (
        !r.ok ||
        data.code !== 'SUCCESS' ||
        typeof data.transactionId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(data.transactionId)
      )
        return { confirmed: false };
      if (
        path === 'confirm' &&
        (data.transactionId !== body.transactionId ||
          data.orderId !== body.orderId)
      )
        return { confirmed: false };
      return {
        confirmed: true,
        transactionId: data.transactionId,
        code: 'SUCCESS',
      };
    } catch {
      return { confirmed: false };
    } finally {
      clearTimeout(timer);
    }
  }
  confirm(body: {
    transactionId: string;
    merchantId: string;
    orderId: string;
    amount: number;
  }) {
    return this.post('confirm', { ...body, method: 'CARD' });
  }
  cancel(body: {
    transactionId: string;
    merchantId: string;
    amount: number;
    partial: boolean;
    reason: string;
  }) {
    return this.post('cancel', {
      method: 'CARD',
      transactionId: body.transactionId,
      merchantId: body.merchantId,
      amount: String(body.amount),
      cancelType: body.partial ? 'P' : 'C',
      cancelRequester: 'CUSTOMER',
      cancelReason: body.reason,
    });
  }
}
