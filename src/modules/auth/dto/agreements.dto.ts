import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/** Consent collected when an account is created. */
export class AgreementsDto {
  @ApiProperty({ description: '[필수] 이용약관 동의' })
  @IsOptional()
  @IsBoolean()
  agreeTerms?: boolean;

  @ApiProperty({ description: '[필수] 개인정보 수집·이용 동의' })
  @IsOptional()
  @IsBoolean()
  agreePrivacy?: boolean;

  @ApiProperty({ description: '[필수] 만 14세 이상 확인' })
  @IsOptional()
  @IsBoolean()
  agreeAge14?: boolean;

  @ApiPropertyOptional({ description: '[선택] 마케팅 정보 수신 동의' })
  @IsOptional()
  @IsBoolean()
  agreeMarketing?: boolean;
}

export function hasRequiredAgreements(dto: AgreementsDto): boolean {
  return (
    dto.agreeTerms === true &&
    dto.agreePrivacy === true &&
    dto.agreeAge14 === true
  );
}
