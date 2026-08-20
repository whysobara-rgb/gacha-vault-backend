import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ShippingService } from './shipping.service';
import { CreateShippingRequestDto } from './dto/create-shipping-request.dto';
import { ListShippingRequestsQueryDto } from './dto/list-shipping-requests.query.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('shipping-requests')
@ApiBearerAuth('access-token')
@Controller('shipping-requests')
@UseGuards(JwtAuthGuard)
export class ShippingController {
  constructor(private readonly shippingService: ShippingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '배송 신청',
    description:
      '보관함의 특정 아이템(들)에 대해 배송을 신청합니다. 고정 배송비(3000 GP)가 차감되며, ' +
      '해당 아이템들은 SHIPPING_REQUESTED 상태로 전환되고 잠금 처리됩니다.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateShippingRequestDto,
  ) {
    return this.shippingService.create(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: '배송 신청 내역 조회', description: '내가 신청한 배송 목록을 페이지네이션하여 반환합니다.' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListShippingRequestsQueryDto,
  ) {
    return this.shippingService.findAll(user.userId, query);
  }
}
