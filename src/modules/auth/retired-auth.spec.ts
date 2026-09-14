import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Repository, DataSource } from 'typeorm';
import { User, AuthProvider } from '../../entities';
import { AuthService } from './auth.service';
import { WalletService } from '../wallet/wallet.service';

describe('retired endpoints cannot affect accounts or balances', () => {
  it('rejects a matching victim email without looking up, linking, or signing', async () => {
    const findOne = jest.fn();
    const save = jest.fn();
    const signAsync = jest.fn();
    const service = new AuthService(
      { findOne, save } as unknown as Repository<User>,
      { signAsync } as unknown as JwtService,
      new ConfigService(),
    );
    await expect(
      service.socialLogin({
        provider: AuthProvider.KAKAO,
        providerId: 'unverified',
        email: 'victim@example.test',
      }),
    ).rejects.toMatchObject({ status: 410 });
    expect(findOne).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(signAsync).not.toHaveBeenCalled();
  });
  it('rejects arbitrary GP grants before opening a transaction', async () => {
    const transaction = jest.fn();
    const service = new WalletService({ transaction } as unknown as DataSource);
    await expect(service.topup(1, { amount: 500000 })).rejects.toMatchObject({
      status: 410,
    });
    expect(transaction).not.toHaveBeenCalled();
  });
});
