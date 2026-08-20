import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { GachaService } from './gacha.service';
import { ListGachasQueryDto } from './dto/list-gachas.query.dto';

@ApiTags('gachas')
@Controller('gachas')
export class GachaController {
  constructor(private readonly gachaService: GachaService) {}

  @Get()
  @ApiOperation({ summary: '가차(랜덤박스) 목록 조회', description: '활성화된 가차 목록을 페이지네이션하여 반환합니다.' })
  findAll(@Query() query: ListGachasQueryDto) {
    return this.gachaService.findAll(query);
  }
}
