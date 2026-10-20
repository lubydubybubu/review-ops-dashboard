import { AppShell } from '@/components/app-shell';
import { requireSession } from '@/server/auth/session';
import { listBrandOptions } from '@/server/db/brands';
import { getPool } from '@/server/db/pool';
import { listTemplates } from '@/server/db/templates';
import { loadSettings, loadStages, loadViews } from '@/server/queries';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  const db = getPool();
  const [stages, templates, brands, settings, views] = await Promise.all([
    loadStages(),
    listTemplates(db),
    listBrandOptions(db),
    loadSettings(),
    loadViews(),
  ]);
  return (
    <AppShell
      stages={stages}
      templates={templates.map(({ bodyMd: _body, checklist: _checklist, ...t }) => t)}
      brands={brands}
      settings={settings}
      views={views.map(({ id, layout, name, position, version }) => ({ id, layout, name, position, version }))}
    >
      {children}
    </AppShell>
  );
}
