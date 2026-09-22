import { Injectable } from '@nestjs/common';
import { requireRecovery } from './recovery.policy';
export type Mail = { from: string; to: string; subject: string; text: string };
export class DeliveryError extends Error {
  constructor(public readonly retryable: boolean) {
    super('Transactional email delivery unavailable');
  }
}
@Injectable()
export class RecoveryMailer {
  async send(id: string, mail: Mail) {
    const c = requireRecovery(),
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + c.apiKey,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'gachi-auth/' + id,
        },
        body: JSON.stringify({ ...mail, to: [mail.to] }),
      });
      if (!r.ok) throw new DeliveryError(r.status === 429 || r.status >= 500);
      const json: any = await r.json();
      if (typeof json.id !== 'string' || json.id.length > 255)
        throw new DeliveryError(true);
      return json.id;
    } catch (e) {
      if (e instanceof DeliveryError) throw e;
      throw new DeliveryError(true);
    } finally {
      clearTimeout(timer);
    }
  }
}
