import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BannersService } from './banners.service';

@ApiTags('banners')
@Controller('banners')
export class BannersController {
  constructor(private readonly bannersService: BannersService) {}

  @Get()
  @ApiOperation({
    summary: '홈 이벤트 배너',
    description:
      '노출 중(active이고 기간 안)인 배너를 우선순위 순으로 반환합니다. ' +
      'link.type에 따라 박스 상세/출석체크/충전/확률 페이지 등으로 이동합니다.',
  })
  findActive() {
    return this.bannersService.findActive();
  }
}
