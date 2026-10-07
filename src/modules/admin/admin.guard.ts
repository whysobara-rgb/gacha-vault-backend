import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { User, UserRole } from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';

/**
 * Lets only ADMIN accounts through. The role is read from the database on
 * every request (not from the token), so revoking it takes effect at once.
 * Use after JwtAuthGuard.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context.switchToHttp().getRequest().user?.userId;
    const isAdmin =
      userId !== undefined &&
      (await this.userRepository.exists({
        where: { id: userId, role: UserRole.ADMIN, deletedAt: IsNull() },
      }));
    if (!isAdmin) {
      throw new BusinessException(
        ResponseCode.FORBIDDEN,
        'Admin only',
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}
