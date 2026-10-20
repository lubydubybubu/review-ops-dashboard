import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { requireSession } from '@/server/auth/session';
import { getPool } from '@/server/db/pool';
import { listTemplates } from '@/server/db/templates';
import { loadSettings, loadStages } from '@/server/queries';
import { PreferencesForm, StageSettings, TemplateSettings } from './settings-forms';

export const metadata: Metadata = { title: '설정' };

export default async function SettingsPage() {
  await requireSession();
  const [settings, stages, templates] = await Promise.all([loadSettings(), loadStages(), listTemplates(getPool())]);
  return (
    <div className="max-w-3xl">
      <PageHeader title="설정" meta="바꾸면 바로 저장됩니다" />
      <div className="flex flex-col gap-12">
        <PreferencesForm settings={settings} />
        <StageSettings stages={stages} />
        <TemplateSettings templates={templates} stages={stages} />
      </div>
    </div>
  );
}
