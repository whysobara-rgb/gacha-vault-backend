import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { DrawsService } from './draws.service';
import { CreateDrawDto } from './dto/create-draw.dto';

@ApiTags('draws')
@ApiBearerAuth('access-token')
@Controller('draws')
@UseGuards(JwtAuthGuard)
export class DrawsController {
  constructor(private readonly drawsService: DrawsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '가차 뽑기',
    description:
      '지정한 가차(gachaId)에서 1회 뽑기를 수행합니다. 잔액 확인/차감/결과 아이템 지급이 하나의 트랜잭션으로 처리됩니다.',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDrawDto) {
    return this.drawsService.createDraw(user.userId, dto);
  }
}
