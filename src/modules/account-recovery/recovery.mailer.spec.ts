import { DeliveryError, RecoveryMailer } from './recovery.mailer';
describe('transactional email provider boundaries', () => {
  const env = { ...process.env },
    fetcher = jest.fn(),
    old = global.fetch,
    mail = {
      from: 'accounts@example.invalid',
      to: 'owner@example.invalid',
      subject: 'test',
      text: 'one-use-link',
    };
  beforeEach(() => {
    Object.assign(process.env, {
      ENABLE_ACCOUNT_RECOVERY: 'true',
      AUTH_MAIL_DELIVERY_ENABLED: 'true',
      AUTH_MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
      AUTH_PUBLIC_WEB_ORIGIN: 'https://gachi.example',
      AUTH_MAIL_FROM: mail.from,
      RESEND_API_KEY: 'fixture-never-transmitted',
    });
    global.fetch = fetcher;
    fetcher.mockReset();
  });
  afterAll(() => {
    global.fetch = old;
    process.env = env;
  });
  it('sends to the fixed endpoint with stable idempotency and no redirects', async () => {
    fetcher.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'mail-1' }),
    });
    await new RecoveryMailer().send('job-1', mail);
    const [url, o] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(o.redirect).toBe('error');
    expect(o.headers['Idempotency-Key']).toBe('gachi-auth/job-1');
    expect(JSON.parse(o.body).to).toEqual([mail.to]);
  });
  it('classifies provider errors without returning response bodies or secrets', async () => {
    fetcher.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => process.env.RESEND_API_KEY,
    });
    await expect(new RecoveryMailer().send('job', mail)).rejects.toMatchObject({
      retryable: false,
      message: 'Transactional email delivery unavailable',
    });
    fetcher.mockResolvedValue({ ok: false, status: 429 });
    await expect(new RecoveryMailer().send('job', mail)).rejects.toMatchObject({
      retryable: true,
    });
    fetcher.mockRejectedValue(new Error('token leak'));
    await expect(new RecoveryMailer().send('job', mail)).rejects.toBeInstanceOf(
      DeliveryError,
    );
  });
});
