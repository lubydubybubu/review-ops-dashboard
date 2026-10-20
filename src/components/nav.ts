export const NAV_ITEMS = [
  { href: '/', label: '대시보드', keywords: ['dashboard', 'home', '홈'], icon: 'home' },
  { href: '/reviews', label: '리뷰 표', keywords: ['table', 'list', '목록', '리뷰'], icon: 'table' },
  { href: '/board', label: '보드', keywords: ['board', 'kanban', '칸반'], icon: 'board' },
  { href: '/calendar', label: '캘린더', keywords: ['calendar', '달력', '일정'], icon: 'calendar' },
  { href: '/mail', label: '메일 의뢰', keywords: ['mail', 'gmail', 'inbox', '메일', '의뢰', '받은편지함'], icon: 'mail' },
  { href: '/brands', label: '브랜드', keywords: ['brand', '협찬'], icon: 'tag' },
  { href: '/settings', label: '설정', keywords: ['settings', '환경'], icon: 'settings' },
] as const;
