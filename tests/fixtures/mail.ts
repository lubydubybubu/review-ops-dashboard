/**
 * Synthetic mail candidates (fictional brands, people and ids) shaped like the producer's POST body.
 * Shared by the unit, integration and E2E suites.
 */

let counter = 0;

/** A fresh hex id (Gmail ids are 16 lowercase hex chars). */
export function hexId(seed?: number): string {
  const n = seed ?? ++counter;
  return (0x18f2a0000000000n + BigInt(n) * 7919n).toString(16).padStart(16, '0');
}

export interface CandidatePayload {
  source: 'gmail';
  message_id: string;
  thread_id: string;
  received_at: string;
  from_name: string | null;
  from_address: string;
  subject: string;
  snippet: string;
  extracted: {
    brand_name: string | null;
    product_name: string | null;
    source_type: 'loan' | 'gift' | 'purchase' | 'unknown';
    deadlines: { write_by: string | null; publish: string | null; embargo: string | null; return_by: string | null };
    notes: string | null;
  };
  evidence: string[];
  confidence: number;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export function candidatePayload(overrides: DeepPartial<CandidatePayload> = {}): CandidatePayload {
  const messageId = overrides.message_id ?? hexId();
  const base: CandidatePayload = {
    source: 'gmail',
    message_id: messageId,
    thread_id: messageId,
    received_at: '2026-10-20T01:15:00Z',
    from_name: '한서윤 (Northwind PR)',
    from_address: 'pr@northwind.example',
    subject: '[리뷰 제안] Northwind NX9 무선 헤드폰 대여 리뷰 가능하실까요?',
    snippet: '안녕하세요, Northwind 마케팅팀입니다. 신제품 NX9를 2주간 대여해 드리고자 합니다.\n엠바고는 11월 3일입니다.',
    extracted: {
      brand_name: 'Northwind',
      product_name: 'Northwind NX9 무선 헤드폰',
      source_type: 'loan',
      deadlines: { write_by: '2026-10-30', publish: '2026-11-04', embargo: '2026-11-03', return_by: '2026-11-10' },
      notes: '반납 시 정품 박스 포함',
    },
    evidence: ['신제품 NX9를 2주간 대여해 드리고자 합니다.', '엠바고는 11월 3일입니다.'],
    confidence: 0.92,
  };
  return {
    ...base,
    ...overrides,
    extracted: {
      ...base.extracted,
      ...overrides.extracted,
      deadlines: { ...base.extracted.deadlines, ...overrides.extracted?.deadlines },
    },
  } as CandidatePayload;
}

/** Strings shaped like injections; they must be stored and shown as the exact characters. */
export const INJECTION = {
  subject: '<img src=x onerror="window.__pwned=1"> 제안 </h3><script>window.__pwned=2</script>',
  fromName: '"><svg onload=window.__pwned=3>',
  brand: '<b>Evil</b> & Co',
  product: '![x](https://tracker.example/p.png) [링크](javascript:alert(1))',
  notes: '## 제목\n<iframe src="https://evil.example"></iframe>\n`code` **굵게**',
  evidence: "'; drop table reviews; --",
  snippet: '<a href="javascript:alert(1)">클릭</a>\n{{constructor.constructor("alert(1)")()}}',
} as const;
