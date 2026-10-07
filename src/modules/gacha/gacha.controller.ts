import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GachaService } from './gacha.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { ListGachasQueryDto } from './dto/list-gachas.query.dto';

@ApiTags('gachas')
@Controller('gachas')
export class GachaController {
  constructor(private readonly gachaService: GachaService) {}

  @Get()
  @ApiOperation({
    summary: '가차(랜덤박스) 목록 조회',
    description: '활성화된 가차 목록을 페이지네이션하여 반환합니다.',
  })
  findAll(@Query() query: ListGachasQueryDto) {
    return this.gachaService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '가차(랜덤박스) 상세 조회',
    description:
      '실시간 재고(totalStock/soldStock)와 실제 드랍 라인업(lineup: 등급/이미지/이름)을 함께 반환합니다.',
  })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.gachaService.findOne(id);
  }

  @Get(':id/odds')
  @ApiOperation({
    summary: '확률 및 구성 정보 공시',
    description:
      '아이템별/등급별 정확한 확률, 천장(pity) 규칙과 실질 SSR 확률, 10+1 보너스, ' +
      '포인트 전환율, 1회당 기대 가치를 반환합니다.',
  })
  getOdds(@Param('id', ParseIntPipe) id: number) {
    return this.gachaService.getOdds(id);
  }

  @Get(':id/pity')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: '내 천장 진행도',
    description:
      '이 박스에서 마지막 SSR 이후 누적 뽑기 수와 SSR 확정까지 남은 횟수를 반환합니다.',
  })
  getPity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.gachaService.getPity(user.userId, id);
  }
}
