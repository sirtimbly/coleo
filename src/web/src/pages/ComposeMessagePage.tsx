/**
 * Hosts the shared message composer as a Golden Layout-compatible projection.
 * Closing returns to the unified Inbox instead of the deprecated Mail route.
 */
import { MessageComposer } from '@/components/MessageModal';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useMessage } from '@/lib';
import { useWorkspaceCloseRoute } from '@/workspace/route-context';

export function ComposeMessagePage() {
  usePageTitle('Coleo Observatory - New Message');
  const closeRoute = useWorkspaceCloseRoute('/messaging');
  const { closeMessageModal, replyContext } = useMessage();

  const closeComposer = () => {
    closeMessageModal();
    closeRoute();
  };

  return <MessageComposer onClose={closeComposer} replyTo={replyContext} />;
}
