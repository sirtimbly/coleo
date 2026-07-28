import { UnifiedGridView } from '@/components';
import { usePageTitle } from '@/hooks/usePageTitle';

export function UnifiedGridPage() {
  usePageTitle('Coleo Observatory - Grid');
  return <UnifiedGridView />;
}