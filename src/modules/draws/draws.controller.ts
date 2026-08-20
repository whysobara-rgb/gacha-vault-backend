import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { DrawsService } from './draws.service';
import { CreateDrawDto } from './dto/create-draw.dto';

@Controller('draws')
@UseGuards(JwtAuthGuard)
export class DrawsController {
  constructor(private readonly drawsService: DrawsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDrawDto) {
    return this.drawsService.createDraw(user.userId, dto);
  }
}
