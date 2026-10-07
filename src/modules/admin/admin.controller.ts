import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import {
  AdminPaymentsQueryDto,
  AdminShippingQueryDto,
  SaveBannerDto,
  UpdateGachaDto,
  UpdateShippingDto,
} from './dto/admin.dto';

@ApiTags('admin')
@ApiBearerAuth('access-token')
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  @ApiOperation({
    summary: '운영 대시보드',
    description:
      '오늘/이번 달/누적 매출, 뽑기 수, 신규 가입, 미사용 GP, 발송 대기·확인 필요 결제 건수.',
  })
  getStats() {
    return this.adminService.getStats();
  }

  @Get('shipping-requests')
  @ApiOperation({ summary: '배송 신청 목록 (오래된 순)' })
  listShipping(@Query() query: AdminShippingQueryDto) {
    return this.adminService.listShipping(query);
  }

  @Patch('shipping-requests/:id')
  @ApiOperation({
    summary: '배송 상태 변경',
    description:
      'REQUESTED → SHIPPING(택배사·송장번호 필수) → DELIVERED. 보관함 아이템 상태도 함께 바뀝니다.',
  })
  updateShipping(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateShippingDto,
  ) {
    return this.adminService.updateShipping(id, dto);
  }

  @Get('gachas')
  @ApiOperation({ summary: '박스 목록 (판매 중지 포함, 판매량·환급률)' })
  listGachas() {
    return this.adminService.listGachas();
  }

  @Patch('gachas/:id')
  @ApiOperation({ summary: '박스 판매 on/off, 회차 수량 변경' })
  updateGacha(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGachaDto,
  ) {
    return this.adminService.updateGacha(id, dto);
  }

  @Get('banners')
  @ApiOperation({ summary: '배너 목록 (비활성 포함)' })
  listBanners() {
    return this.adminService.listBanners();
  }

  @Post('banners')
  @ApiOperation({ summary: '배너 생성' })
  createBanner(@Body() dto: SaveBannerDto) {
    return this.adminService.createBanner(dto);
  }

  @Patch('banners/:id')
  @ApiOperation({ summary: '배너 수정 (노출 기간, 링크, on/off)' })
  updateBanner(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveBannerDto,
  ) {
    return this.adminService.updateBanner(id, dto);
  }

  @Get('payments')
  @ApiOperation({ summary: '결제 내역 (상태 필터)' })
  listPayments(@Query() query: AdminPaymentsQueryDto) {
    return this.adminService.listPayments(query);
  }

  @Get('users')
  @ApiOperation({ summary: '회원 검색 (이메일·닉네임)' })
  findUsers(@Query('search') search?: string) {
    return this.adminService.findUsers(search?.slice(0, 100));
  }
}
