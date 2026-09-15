import { Repository } from 'typeorm';
import { InventoryItem, InventoryStatus } from '../../entities';
import { InventoryService } from './inventory.service';

describe('InventoryService.setLock', () => {
  function fixture(item: Partial<InventoryItem> | null) {
    const query = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(item),
    };
    const save = jest.fn().mockImplementation(async (value) => value);
    const repository = { createQueryBuilder: () => query, save };
    const transaction = jest.fn(async (callback) =>
      callback({ getRepository: () => repository }),
    );
    const service = new InventoryService({
      manager: { transaction },
    } as unknown as Repository<InventoryItem>);
    return { service, query, save, transaction };
  }
  it('sets explicit state atomically and scopes the row to the authenticated owner', async () => {
    const f = fixture({
      id: 7,
      status: InventoryStatus.STORED,
      isLocked: false,
    });
    expect(await f.service.setLock(10, 7, true)).toEqual({
      inventoryItemId: 7,
      isLocked: true,
      status: 'STORED',
    });
    expect(f.query.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(f.query.andWhere).toHaveBeenCalledWith(
      'inventory.userId = :userId',
      { userId: 10 },
    );
    expect(f.save).toHaveBeenCalledTimes(1);
    await f.service.setLock(10, 7, true);
    expect(f.save).toHaveBeenCalledTimes(1);
    await f.service.setLock(10, 7, false);
    expect(f.save).toHaveBeenCalledTimes(2);
  });
  it('missing and foreign-owned IDs do not write', async () => {
    const f = fixture(null);
    await expect(f.service.setLock(10, 7, true)).rejects.toMatchObject({
      status: 404,
    });
    expect(f.save).not.toHaveBeenCalled();
  });
  it.each([
    InventoryStatus.SHIPPING_REQUESTED,
    InventoryStatus.SHIPPING,
    InventoryStatus.DELIVERED,
  ])('rejects changes in %s', async (status) => {
    const f = fixture({ id: 7, status, isLocked: true });
    await expect(f.service.setLock(10, 7, false)).rejects.toMatchObject({
      status: 409,
    });
    expect(f.save).not.toHaveBeenCalled();
  });
  it('validates service inputs before opening a transaction', async () => {
    const f = fixture(null);
    await expect(f.service.setLock(10, 0, true)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      f.service.setLock(10, 7, 'false' as unknown as boolean),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.transaction).not.toHaveBeenCalled();
  });
});
