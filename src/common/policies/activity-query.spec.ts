import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListPointHistoryQueryDto } from '../../modules/wallet/dto/list-point-history.query.dto';
import { ListShippingRequestsQueryDto } from '../../modules/shipping/dto/list-shipping-requests.query.dto';
import { ListInventoryQueryDto } from '../../modules/inventory/dto/list-inventory.query.dto';

describe.each([
  ListPointHistoryQueryDto,
  ListShippingRequestsQueryDto,
  ListInventoryQueryDto,
])('%p activity query limits', (Query) => {
  it.each([
    { page: '0' },
    { page: '1.5' },
    { page: '1000001' },
    { limit: '0' },
    { limit: '101' },
    { limit: 'Infinity' },
  ])('rejects unsafe pagination %p', async (query) => {
    expect(await validate(plainToInstance(Query, query))).not.toHaveLength(0);
  });
  it('accepts existing default and bounded paginated clients', async () => {
    expect(await validate(plainToInstance(Query, {}))).toHaveLength(0);
    expect(
      await validate(plainToInstance(Query, { page: '6', limit: '100' })),
    ).toHaveLength(0);
  });
});
