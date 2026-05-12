/**
 * Message Context - Provides global message/reply functionality
 */
import { createContext, useContext, useState, type ReactNode } from 'react';

export interface ReplyContext {
  messageId: string;
  threadId?: string;
  from: string;
  subject: string;
  body: string;
}

interface MessageContextValue {
  isMessageModalOpen: boolean;
  replyContext: ReplyContext | undefined;
  openNewMessage: () => void;
  openReply: (context: ReplyContext) => void;
  closeMessageModal: () => void;
}

const MessageContext = createContext<MessageContextValue | null>(null);

export function MessageProvider({ children }: { children: ReactNode }) {
  const [isMessageModalOpen, setIsMessageModalOpen] = useState(false);
  const [replyContext, setReplyContext] = useState<ReplyContext | undefined>(undefined);

  const openNewMessage = () => {
    setReplyContext(undefined);
    setIsMessageModalOpen(true);
  };

  const openReply = (context: ReplyContext) => {
    setReplyContext(context);
    setIsMessageModalOpen(true);
  };

  const closeMessageModal = () => {
    setIsMessageModalOpen(false);
    setReplyContext(undefined);
  };

  return (
    <MessageContext.Provider value={{
      isMessageModalOpen,
      replyContext,
      openNewMessage,
      openReply,
      closeMessageModal,
    }}>
      {children}
    </MessageContext.Provider>
  );
}

export function useMessage() {
  const context = useContext(MessageContext);
  if (!context) {
    throw new Error('useMessage must be used within a MessageProvider');
  }
  return context;
}
