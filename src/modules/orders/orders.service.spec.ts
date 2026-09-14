import { DataSource } from 'typeorm';
import { OrdersService } from './orders.service';
const dto = { gachaId: 1, quantity: 1, expectedUnitPrice: 100 };
const key = 'd4b608db-b251-4616-8017-c1eea6a9c1a1';

describe('GP order rollout and input boundaries', () => {
  const previous = { ...process.env };
  const transaction = jest.fn();
  const service = new OrdersService({ transaction } as unknown as DataSource);
  afterEach(() => {
    process.env = { ...previous };
    transaction.mockClear();
  });
  it.each(['production', '', 'staging'])(
    'never writes in %s even with the preview flag',
    async (env) => {
      process.env.NODE_ENV = env;
      process.env.ENABLE_GP_ORDER_PREVIEW = 'true';
      await expect(service.purchase(1, key, dto)).rejects.toMatchObject({
        status: 503,
      });
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it('requires explicit opt-in and excludes simultaneous legacy writes', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ENABLE_GP_ORDER_PREVIEW;
    await expect(service.purchase(1, key, dto)).rejects.toMatchObject({
      status: 503,
    });
    process.env.ENABLE_GP_ORDER_PREVIEW = 'true';
    process.env.ENABLE_LEGACY_TRANSACTIONS = 'true';
    await expect(service.purchase(1, key, dto)).rejects.toMatchObject({
      status: 503,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    { ...dto, quantity: 0 },
    { ...dto, quantity: 101 },
    { ...dto, quantity: 1.5 },
    { ...dto, expectedUnitPrice: 0 },
    { ...dto, gachaId: -1 },
  ])('validates purchase arguments before DB writes: %j', async (invalid) => {
    process.env.NODE_ENV = 'test';
    process.env.ENABLE_GP_ORDER_PREVIEW = 'true';
    delete process.env.ENABLE_LEGACY_TRANSACTIONS;
    await expect(service.purchase(1, key, invalid)).rejects.toMatchObject({
      status: 400,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
  it('requires a UUID v4 request key', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ENABLE_GP_ORDER_PREVIEW = 'true';
    delete process.env.ENABLE_LEGACY_TRANSACTIONS;
    await expect(service.purchase(1, '', dto)).rejects.toMatchObject({
      status: 400,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
