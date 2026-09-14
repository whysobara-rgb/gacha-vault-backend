import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { AuthProvider, User } from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { SocialLoginDto } from './dto/social-login.dto';

const BCRYPT_SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async signup(dto: SignupDto) {
    const existing = await this.userRepository.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new BusinessException(
        ResponseCode.CONFLICT,
        'Email already registered',
        HttpStatus.CONFLICT,
      );
    }

    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    const user = this.userRepository.create({
      email: dto.email,
      password: hashedPassword,
      nickname: dto.nickname,
      coinBalance: 0,
      provider: AuthProvider.EMAIL,
    });
    const saved = await this.userRepository.save(user);

    return {
      id: saved.id,
      email: saved.email,
      nickname: saved.nickname,
      createdAt: saved.createdAt,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.email = :email', { email: dto.email })
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

    const expiresIn = Number(
      this.configService.get<string>('JWT_EXPIRES_IN') ?? 3600,
    );
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, email: user.email },
      { expiresIn },
    );

    return {
      accessToken,
      expiresIn,
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
      },
    };
  }

  /** Retired: unverified provider IDs must never authenticate or link accounts. */
  async socialLogin(_dto: SocialLoginDto): Promise<never> {
    throw new BusinessException(
      ResponseCode.FORBIDDEN,
      '소셜 로그인은 제공자 인증 검증 연동 후 사용할 수 있습니다',
      HttpStatus.GONE,
    );
  }
}
