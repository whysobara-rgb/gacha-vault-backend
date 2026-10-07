import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import {
  AuthProvider,
  User,
  WalletTransaction,
  WalletTransactionReason,
  WalletTransactionType,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { WELCOME_GP } from '../../common/constants/economy.constant';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { SocialLoginDto } from './dto/social-login.dto';
import { AgreementsDto, hasRequiredAgreements } from './dto/agreements.dto';
import {
  ProviderNotConfiguredError,
  ProviderUnavailableError,
  SocialIdentity,
  SocialVerifier,
} from './social/social-verifier';

const BCRYPT_SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly socialVerifier: SocialVerifier,
  ) {}

  /** Social providers the server can verify, so the app shows only those. */
  getProviders() {
    return { providers: this.socialVerifier.configuredProviders() };
  }

  async signup(dto: SignupDto) {
    requireAgreements(dto);
    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    const saved = await this.dataSource.transaction(async (manager) => {
      const existing = await manager
        .getRepository(User)
        .findOne({ where: { email: dto.email } });
      if (existing) {
        throw new BusinessException(
          ResponseCode.CONFLICT,
          'Email already registered',
          HttpStatus.CONFLICT,
        );
      }
      return this.createAccount(manager, dto, {
        email: dto.email,
        password: hashedPassword,
        nickname: dto.nickname,
        provider: AuthProvider.EMAIL,
        providerId: null,
      });
    });

    return {
      ...(await this.issueToken(saved)),
      id: saved.id,
      email: saved.email,
      nickname: saved.nickname,
      welcomeGp: WELCOME_GP,
      createdAt: saved.createdAt,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.email = :email', { email: dto.email })
      .andWhere('user.deletedAt IS NULL')
      .getOne();

    if (!user) {
      throw new BusinessException(
        ResponseCode.UNAUTHORIZED,
        'Invalid email or password',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (!user.password) {
      // Account was created via social login and has no local password set.
      throw new BusinessException(
        ResponseCode.UNAUTHORIZED,
        'This account uses social login. Please sign in with the original provider.',
        HttpStatus.UNAUTHORIZED,
        [`provider:${user.provider}`],
      );
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatches) {
      throw new BusinessException(
        ResponseCode.UNAUTHORIZED,
        'Invalid email or password',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return {
      ...(await this.issueToken(user)),
      user: { id: user.id, email: user.email, nickname: user.nickname },
    };
  }

  /**
   * Social login (Kakao/Google/Naver/Apple). The provider token is verified
   * server-side; the provider's user id from that token is the only key.
   *
   *   1. (provider, providerId) matches an active account → sign in.
   *   2. The provider's email belongs to another account → 10011. Accounts
   *      are never linked by email, so nobody can claim an account by
   *      presenting a matching address.
   *   3. Otherwise create an account, which needs the required agreements
   *      (→ 10010 so the app can ask and retry with the same token).
   */
  async socialLogin(dto: SocialLoginDto) {
    const identity = await this.verifySocialToken(dto);

    return this.dataSource.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const existing = await users.findOne({
        where: {
          provider: dto.provider,
          providerId: identity.providerId,
          deletedAt: IsNull(),
        },
      });
      if (existing) {
        return {
          ...(await this.issueToken(existing)),
          user: publicUser(existing),
          isNewUser: false,
        };
      }

      if (identity.email) {
        const owner = await users.findOne({
          where: { email: identity.email },
        });
        if (owner) {
          throw new BusinessException(
            ResponseCode.EMAIL_ALREADY_REGISTERED,
            'This email is already registered with another sign-in method',
            HttpStatus.CONFLICT,
            [`provider:${owner.provider}`],
          );
        }
      }

      requireAgreements(dto);
      const user = await this.createAccount(manager, dto, {
        // users.email is unique and required; providers may withhold it.
        email:
          identity.email ??
          `${dto.provider.toLowerCase()}_${identity.providerId}@users.gachivault.invalid`,
        password: null,
        nickname: pickNickname(dto, identity),
        provider: dto.provider,
        providerId: identity.providerId,
      });
      return {
        ...(await this.issueToken(user)),
        user: publicUser(user),
        isNewUser: true,
        welcomeGp: WELCOME_GP,
      };
    });
  }

  private async verifySocialToken(
    dto: SocialLoginDto,
  ): Promise<SocialIdentity> {
    try {
      return await this.socialVerifier.verify(dto.provider, dto.token);
    } catch (err) {
      if (
        err instanceof ProviderNotConfiguredError ||
        err instanceof ProviderUnavailableError
      ) {
        throw new BusinessException(
          ResponseCode.SOCIAL_PROVIDER_UNAVAILABLE,
          `${dto.provider} login is not available right now`,
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw new BusinessException(
        ResponseCode.UNAUTHORIZED,
        'Invalid social login token',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  /** Creates an account with consent records and the welcome GP. */
  private async createAccount(
    manager: EntityManager,
    agreements: AgreementsDto,
    fields: Pick<
      User,
      'email' | 'password' | 'nickname' | 'provider' | 'providerId'
    >,
  ): Promise<User> {
    const now = new Date();
    const user = await manager.getRepository(User).save(
      manager.getRepository(User).create({
        ...fields,
        coinBalance: WELCOME_GP,
        termsAgreedAt: now,
        marketingAgreedAt: agreements.agreeMarketing ? now : null,
      }),
    );
    await manager.getRepository(WalletTransaction).save(
      manager.getRepository(WalletTransaction).create({
        userId: user.id,
        type: WalletTransactionType.EARN,
        reason: WalletTransactionReason.SIGNUP_BONUS,
        amount: WELCOME_GP,
        description: '회원가입 축하 GP',
        balanceAfter: WELCOME_GP,
      }),
    );
    return user;
  }

  private async issueToken(user: User) {
    const expiresIn = Number(
      this.configService.get<string>('JWT_EXPIRES_IN') ?? 3600,
    );
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, email: user.email },
      { expiresIn },
    );
    return { accessToken, expiresIn };
  }
}

function requireAgreements(dto: AgreementsDto) {
  if (!hasRequiredAgreements(dto)) {
    throw new BusinessException(
      ResponseCode.TERMS_REQUIRED,
      'Required agreements (terms, privacy, age 14+) are missing',
      HttpStatus.BAD_REQUEST,
      ['agreeTerms', 'agreePrivacy', 'agreeAge14'],
    );
  }
}

function pickNickname(dto: SocialLoginDto, identity: SocialIdentity): string {
  const candidate = (dto.nickname ?? identity.nickname ?? '').trim();
  if (candidate.length >= 2) return candidate.slice(0, 20);
  return `가치유저${identity.providerId.slice(-4).padStart(4, '0')}`;
}

function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    provider: user.provider,
  };
}
