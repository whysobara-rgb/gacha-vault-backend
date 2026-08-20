import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InventoryService } from './inventory.service';
import { ListInventoryQueryDto } from './dto/list-inventory.query.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('inventory')
@UseGuards(JwtAuthGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get()
  @ApiOperation({
    summary: '인벤토리(보관함) 목록 조회',
    description: '현재 로그인한 사용자가 뽑기로 획득해 보관 중인 아이템 목록을 페이지네이션하여 반환합니다.',
  })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListInventoryQueryDto,
  ) {
    return this.inventoryService.findAll(user.userId, query);
  }
}
