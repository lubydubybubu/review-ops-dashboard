import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-[18px] font-semibold">찾는 페이지가 없습니다</h1>
      <p className="text-[13px] text-muted">삭제되었거나 주소가 잘못되었을 수 있습니다.</p>
      <Link href="/" className="btn mt-2">
        대시보드로
      </Link>
    </main>
  );
}
