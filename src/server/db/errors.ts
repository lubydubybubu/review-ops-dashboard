/** Map PostgreSQL errors the owner can cause to short Korean messages. */

const CONSTRAINT_MESSAGE: Record<string, string> = {
  reviews_received_before_shoot: '촬영일은 입고일 이후여야 합니다.',
  reviews_shoot_before_write_due: '작성 마감은 촬영일 이후여야 합니다.',
  reviews_shoot_before_publish: '발행 예정일은 촬영일 이후여야 합니다.',
  reviews_shoot_time_on_day: '촬영 시간은 촬영일 안에 있어야 합니다.',
  reviews_shoot_end_after_start: '종료 시간은 시작 시간보다 늦어야 합니다.',
  brands_name_uq: '같은 이름의 브랜드가 이미 있습니다.',
  workflow_stages_name_uq: '같은 이름의 단계가 이미 있습니다.',
  templates_name_uq: '같은 이름의 템플릿이 이미 있습니다.',
  saved_views_layout_name_uq: '같은 이름의 보기가 이미 있습니다.',
};

interface PgError {
  code?: string;
  constraint?: string;
}

function isPgError(error: unknown): error is PgError {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}

/** A user-facing message for known DB rule violations, otherwise null (treat as a bug). */
export function friendlyDbError(error: unknown): string | null {
  if (!isPgError(error)) return null;
  if (error.constraint && CONSTRAINT_MESSAGE[error.constraint]) return CONSTRAINT_MESSAGE[error.constraint]!;
  switch (error.code) {
    case '23505':
      return '이미 같은 값이 있습니다.';
    case '23503':
      return '연결된 항목이 없거나, 다른 항목이 아직 사용하고 있습니다.';
    case '23514':
    case '23502':
    case '22007':
    case '22008':
      return '입력값이 규칙에 맞지 않습니다.';
    default:
      return null;
  }
}
