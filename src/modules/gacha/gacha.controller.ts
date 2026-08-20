import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
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

  @Get(':id')
  @ApiOperation({
    summary: '가차(랜덤박스) 상세 조회',
    description:
      '실시간 재고(totalStock/soldStock)와 실제 드랍 라인업(lineup: 등급/이미지/이름)을 함께 반환합니다.',
  })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.gachaService.findOne(id);
  }
}
