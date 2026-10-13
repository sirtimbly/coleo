/**
 * Route wrapper for the consolidated resource-sheet workspace.
 */

import { UnifiedGridView } from '@/components';
import { usePageTitle } from '@/hooks/usePageTitle';

export function UnifiedGridPage() {
  usePageTitle('Coleo Observatory - Resource Sheets');
  return <UnifiedGridView />;
}
