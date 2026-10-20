import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { hasSession } from '@/server/auth/session';
import { loadSettings } from '@/server/queries';
// Hangul fallback (Inter has no Korean glyphs): self-hosted, split by unicode-range.
import './fonts/pretendard.css';
import './globals.css';

const inter = localFont({
  src: [
    { path: './fonts/inter-latin-wght-normal.woff2', weight: '100 900', style: 'normal' },
    { path: './fonts/inter-latin-ext-wght-normal.woff2', weight: '100 900', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'Review Ops', template: '%s · Review Ops' },
  description: '리뷰 일정 관리',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F8F8F8' },
    { media: '(prefers-color-scheme: dark)', color: '#121212' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await hasSession()) ? (await loadSettings()).theme : 'system';
  const themeClass = theme === 'system' ? '' : theme;
  return (
    <html lang="ko" className={`${inter.variable} ${themeClass}`.trim()}>
      <body>{children}</body>
    </html>
  );
}
