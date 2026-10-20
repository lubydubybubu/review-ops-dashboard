import { AppShell } from '@/components/app-shell';
import { requireSession } from '@/server/auth/session';
import { listBrandOptions } from '@/server/db/brands';
import { getPool } from '@/server/db/pool';
import { listTemplates } from '@/server/db/templates';
import { loadSettings, loadStages } from '@/server/queries';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  const db = getPool();
  const [stages, templates, brands, settings] = await Promise.all([
    loadStages(),
    listTemplates(db),
    listBrandOptions(db),
    loadSettings(),
  ]);
  return (
    <AppShell
      stages={stages}
      templates={templates.map(({ bodyMd: _body, checklist: _checklist, ...t }) => t)}
      brands={brands}
      settings={settings}
    >
      {children}
    </AppShell>
  );
}
