import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The fields of a Toss Payment object this app relies on. */
export interface TossPayment {
  paymentKey: string;
  orderId: string;
  status: string; // READY | IN_PROGRESS | DONE | CANCELED | ABORTED | EXPIRED | ...
  totalAmount: number;
  method: string | null;
  approvedAt: string | null;
}

/** Toss answered and declined (card refused, invalid key, ...). */
export class TossDeclinedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** No usable answer (network error, timeout, 5xx): the outcome is unknown. */
export class TossUnavailableError extends Error {}

type FetchFn = typeof fetch;

/**
 * Minimal Toss Payments v1 client: confirm a payment and look one up.
 * Authenticates with the secret key (HTTP Basic, empty password).
 */
@Injectable()
export class TossPaymentsClient {
  private fetchFn: FetchFn = (input, init) => fetch(input, init);

  constructor(private readonly config: ConfigService) {}

  useFetch(fetchFn: FetchFn) {
    this.fetchFn = fetchFn;
  }

  get enabled(): boolean {
    return !!this.secretKey && !!this.clientKey;
  }

  get clientKey(): string | undefined {
    return this.config.get<string>('TOSS_CLIENT_KEY')?.trim() || undefined;
  }

  private get secretKey(): string | undefined {
    return this.config.get<string>('TOSS_SECRET_KEY')?.trim() || undefined;
  }

  private get baseUrl(): string {
    return (
      this.config.get<string>('TOSS_API_BASE_URL')?.trim() ||
      'https://api.tosspayments.com'
    );
  }

  /** Approves a payment the user authenticated in the Toss widget. */
  confirm(paymentKey: string, orderId: string, amount: number) {
    return this.request('POST', '/v1/payments/confirm', {
      body: { paymentKey, orderId, amount },
      // Toss de-duplicates repeated confirms with the same key.
      idempotencyKey: `confirm-${orderId}`,
    });
  }

  getPayment(paymentKey: string) {
    return this.request(
      'GET',
      `/v1/payments/${encodeURIComponent(paymentKey)}`,
      {},
    );
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; idempotencyKey?: string },
  ): Promise<TossPayment> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new TossUnavailableError(`${method} ${path} failed`);
    }

    const payload: any = await res.json().catch(() => ({}));
    if (res.status >= 500) {
      throw new TossUnavailableError(`${method} ${path}: ${res.status}`);
    }
    if (!res.ok) {
      throw new TossDeclinedError(
        String(payload.code ?? res.status),
        String(payload.message ?? 'Payment declined'),
      );
    }
    return {
      paymentKey: payload.paymentKey,
      orderId: payload.orderId,
      status: payload.status,
      totalAmount: Number(payload.totalAmount),
      method: payload.method ?? null,
      approvedAt: payload.approvedAt ?? null,
    };
  }
}
