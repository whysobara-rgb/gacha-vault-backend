import { DanalProvider, DANAL_ORIGIN, danalConfig } from './danal.provider';
describe('Danal server adapter boundaries', () => {
  const original = { ...process.env },
    originalFetch = global.fetch;
  let service: DanalProvider, fetchMock: jest.Mock;
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
      ENABLE_DANAL_TEST_PAYMENTS: 'true',
      DANAL_SECRET_KEY: 'SK_TEST_fixture',
      DANAL_CLIENT_KEY: 'CL_TEST_fixture',
      DANAL_MERCHANT_ID: 'TESTMERCHANT',
    });
    service = new DanalProvider();
    fetchMock = jest.fn(async (_url: any, _opts: any) => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          code: 'SUCCESS',
          transactionId: 'auth-tid',
          orderId: 'order',
        }),
    }));
    global.fetch = fetchMock as any;
  });
  afterEach(() => {
    process.env = { ...original };
    global.fetch = originalFetch;
  });
  const body = {
    transactionId: 'auth-tid',
    merchantId: 'TESTMERCHANT',
    orderId: 'order',
    amount: 1000,
  };
  it('uses the fixed HTTPS server endpoint and Basic secret-with-colon header', async () => {
    expect((await service.confirm(body)).confirmed).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(DANAL_ORIGIN + '/payments/confirm');
    expect(opts.redirect).toBe('error');
    expect(opts.headers.Authorization).toBe(
      'Basic ' + Buffer.from('SK_TEST_fixture:').toString('base64'),
    );
    expect(JSON.parse(opts.body)).toMatchObject({ ...body, method: 'CARD' });
    expect(JSON.stringify(service.config())).not.toContain('SK_TEST');
  });
  it('uses cancel endpoint and explicit P/C type, retaining the separate cancellation transaction ID', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ code: 'SUCCESS', transactionId: 'cancel-tid' }),
    });
    const result = await service.cancel({
      ...body,
      partial: true,
      reason: 'test',
    });
    expect(result.transactionId).toBe('cancel-tid');
    expect(fetchMock.mock.calls[0][0]).toBe(DANAL_ORIGIN + '/payments/cancel');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      cancelType: 'P',
      amount: '1000',
      transactionId: 'auth-tid',
    });
    await service.cancel({ ...body, partial: false, reason: 'test' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).cancelType).toBe('C');
  });
  it.each([
    { code: 'SUCCESS', transactionId: 'other', orderId: 'order' },
    { code: 'SUCCESS', transactionId: 'auth-tid', orderId: 'other' },
    { code: 'ALREADY_APPROVED', transactionId: 'auth-tid' },
    null,
  ])(
    'treats mismatched or unverified responses as unknown: %j',
    async (data) => {
      fetchMock.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify(data),
      });
      expect((await service.confirm(body)).confirmed).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it('does not automatically retry a timeout/network error', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    expect((await service.confirm(body)).confirmed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('requires test configuration and cannot be activated in production or with live keys', () => {
    process.env.NODE_ENV = 'production';
    expect(service.ready()).toBe(false);
    process.env.NODE_ENV = 'test';
    process.env.DANAL_SECRET_KEY = 'SK_LIVE_fake';
    expect(() => danalConfig()).toThrow();
    process.env.DANAL_SECRET_KEY = 'SK_TEST_fixture';
    process.env.ENABLE_LEGACY_TRANSACTIONS = 'true';
    expect(service.ready()).toBe(false);
  });
});
