import { Controller, Get, Query, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RankingsService } from './rankings.service';

@ApiTags('rankings')
@Controller('rankings')
export class RankingsController {
  constructor(private readonly rankingsService: RankingsService) {}

  @Get('users')
  @ApiOperation({
    summary: '유저 랭킹 (명예의 전당)',
    description: '누적 획득가치(estimatedValue 합) 기준 유저 랭킹 Top N을 반환합니다.',
  })
  getUserRanking(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.rankingsService.getUserRanking(limit);
  }

  @Get('gachas')
  @ApiOperation({
    summary: '인기 랜덤박스 랭킹',
    description: '전체 기간 뽑기 횟수 기준 인기 랜덤박스 Top N을 반환합니다.',
  })
  getPopularGachas(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.rankingsService.getPopularGachas(limit);
  }

  @Get('wins')
  @ApiOperation({
    summary: '실시간 당첨 피드',
    description: '최근 당첨 내역(닉네임 마스킹 처리)을 최신순으로 반환합니다.',
  })
  getRecentBigWins(
    @Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number,
  ) {
    return this.rankingsService.getRecentBigWins(limit);
  }
}
