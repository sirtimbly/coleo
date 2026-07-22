import { MessageComposer } from '@/components/MessageModal';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useMessage } from '@/lib';
import { useWorkspaceCloseRoute } from '@/workspace/route-context';

export function ComposeMessagePage() {
  usePageTitle('Coleo Observatory - New Message');
  const closeRoute = useWorkspaceCloseRoute('/mail');
  const { closeMessageModal, replyContext } = useMessage();

  const closeComposer = () => {
    closeMessageModal();
    closeRoute();
  };

  return <MessageComposer onClose={closeComposer} replyTo={replyContext} />;
}
