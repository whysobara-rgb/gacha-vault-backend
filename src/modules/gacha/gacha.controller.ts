import { Controller, Get, Query } from '@nestjs/common';
import { GachaService } from './gacha.service';
import { ListGachasQueryDto } from './dto/list-gachas.query.dto';

@Controller('gachas')
export class GachaController {
  constructor(private readonly gachaService: GachaService) {}

  @Get()
  findAll(@Query() query: ListGachasQueryDto) {
    return this.gachaService.findAll(query);
  }
}
