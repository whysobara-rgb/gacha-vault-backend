import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetInventoryLockDto {
  @ApiProperty({
    description: '포인트 전환 잠금 여부. 배송을 제한하지 않습니다.',
  })
  @IsBoolean()
  locked: boolean;
}
