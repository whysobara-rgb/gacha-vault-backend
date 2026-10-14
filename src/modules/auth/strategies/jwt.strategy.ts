import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../../entities';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';

export interface JwtPayload {
  sub: number;
  email: string;
  av?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
      algorithms: ['HS256'],
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const version = payload.av ?? 0;
    if (
      !Number.isSafeInteger(payload.sub) ||
      payload.sub < 1 ||
      !Number.isSafeInteger(version) ||
      version < 0
    )
      throw new UnauthorizedException('다시 로그인해주세요');
    const user = await this.users.findOne({
      where: { id: payload.sub },
      select: ['id', 'email', 'authVersion'],
    });
    if (!user || user.authVersion !== version)
      throw new UnauthorizedException('다시 로그인해주세요');
    return { userId: user.id, email: user.email, authVersion: version };
  }
}
