import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { IsNull, Repository } from 'typeorm';
import { User } from '../../../entities';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';

export interface JwtPayload {
  sub: number;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  /** Tokens of deleted (탈퇴) accounts stop working immediately. */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const active = await this.userRepository.exists({
      where: { id: payload.sub, deletedAt: IsNull() },
    });
    if (!active) throw new UnauthorizedException();
    return { userId: payload.sub, email: payload.email };
  }
}
