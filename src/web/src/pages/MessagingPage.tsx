/**
 * Unified Messaging Page
 * Combines Mail, Status Reports, and Proposals in one interface
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Button, Card } from '@heroui/react';
import { api, type StatusReport, type MailMessage, useToast, useMessage } from '@/lib';
import { useWebSocket } from '@/hooks/useWebSocket';
import { RefreshCw, AlertCircle, Mail, FileText, Vote, MessageSquare, Archive, CheckCircle, Eye, EyeOff, Maximize2, Minimize2, Reply } from 'lucide-react';

type MessageType = 'all' | 'mail' | 'sent' | 'archive' | 'status-reports' | 'proposals';

interface UnifiedMessage {
  id: string;
  type: 'mail' | 'sent' | 'archive' | 'status-report' | 'proposal';
  timestamp: string;
  title: string;
  summary: string;
  status?: string;
  priority?: 'critical' | 'high' | 'normal' | 'low';
  unread?: boolean;
  data: unknown;
}

export function MessagingPage() {
  document.title = "Coleo Observatory - Messaging";
  const [activeTab, setActiveTab] = useState<MessageType>('all');
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<UnifiedMessage | null>(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [panelWidth, setPanelWidth] = useState(400);
  const [isResizing, setIsResizing] = useState(false);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const [previousMessageCount, setPreviousMessageCount] = useState(0);
  const resizeRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();
  const { openReply } = useMessage();

  const loadMessages = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [mailResponse, sentResponse, archiveResponse, statusReportsResponse] = await Promise.all([
        api.listInbox({ limit: 50 }),
        api.listSent({ limit: 50 }),
        api.listArchive({ limit: 50 }),
        api.listStatusReports({ limit: 50 }),
      ]);

      const unifiedMessages: UnifiedMessage[] = [];

      mailResponse.messages.forEach((mail: MailMessage) => {
        unifiedMessages.push({
          id: `mail-${mail.id}`,
          type: 'mail',
          timestamp: mail.date,
          title: mail.subject,
          summary: mail.body.substring(0, 100) + (mail.body.length > 100 ? '...' : ''),
          unread: !mail.flags.seen,
          priority: mail.flags.flagged ? 'high' : 'normal',
          data: mail,
        });
      });

      sentResponse.messages.forEach((mail: MailMessage) => {
        unifiedMessages.push({
          id: `sent-${mail.id}`,
          type: 'sent',
          timestamp: mail.date,
          title: mail.subject,
          summary: mail.body.substring(0, 100) + (mail.body.length > 100 ? '...' : ''),
          unread: false,
          priority: mail.flags.flagged ? 'high' : 'normal',
          data: mail,
        });
      });

      archiveResponse.messages.forEach((mail: MailMessage) => {
        unifiedMessages.push({
          id: `archive-${mail.id}`,
          type: 'archive',
          timestamp: mail.date,
          title: mail.subject,
          summary: mail.body.substring(0, 100) + (mail.body.length > 100 ? '...' : ''),
          unread: false,
          priority: mail.flags.flagged ? 'high' : 'normal',
          data: mail,
        });
      });

      statusReportsResponse.reports.forEach((report: StatusReport) => {
        unifiedMessages.push({
          id: `status-${report.id}`,
          type: 'status-report',
          timestamp: report.createdAt,
          title: `Status: ${report.armId}`,
          summary: report.summary,
          status: report.status,
          priority: report.status === 'blocked' ? 'critical' :
                   report.status === 'issues_found' ? 'high' : 'normal',
          data: report,
        });
      });

      unifiedMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      setMessages(unifiedMessages);

      const newUnreadCount = unifiedMessages.filter(m => m.unread).length;
      const previousUnreadCount = messages.filter(m => m.unread).length;

      if (previousMessageCount > 0 && newUnreadCount > previousUnreadCount) {
        const newMessages = newUnreadCount - previousUnreadCount;
        showToast(
          `You have ${newMessages} new message${newMessages > 1 ? 's' : ''}`,
          'info',
          4000
        );
      }

      setPreviousMessageCount(unifiedMessages.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  }, [previousMessageCount, showToast]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // WebSocket listener for real-time mail updates
  useWebSocket({
    channels: ['mail'],
    onMessage: (message) => {
      if (message.channel === 'mail') {
        // Refresh messages when new mail events occur
        if (message.event === 'mail.sent' || message.event === 'mail.received') {
          loadMessages();
        }
      }
    },
  });

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = e.clientX;
      if (newWidth > 300 && newWidth < window.innerWidth - 400) {
        setPanelWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const filteredMessages = messages.filter(msg => {
    if (activeTab === 'all') return true;
    if (activeTab === 'mail') return msg.type === 'mail';
    if (activeTab === 'sent') return msg.type === 'sent';
    if (activeTab === 'archive') return msg.type === 'archive';
    if (activeTab === 'status-reports') return msg.type === 'status-report';
    if (activeTab === 'proposals') return msg.type === 'proposal';
    return true;
  });

  const handleMessageClick = useCallback((message: UnifiedMessage) => {
    setSelectedMessage(message);
    if (message.unread) {
      setMessages(prev => prev.map(m =>
        m.id === message.id ? { ...m, unread: false } : m
      ));
    }
  }, []);

  const handleMarkRead = useCallback((messageIds: string[], read: boolean) => {
    setMessages(prev => prev.map(m =>
      messageIds.includes(m.id) ? { ...m, unread: !read } : m
    ));
  }, []);

  const handleArchive = useCallback(async (messageIds: string[]) => {
    try {
      await Promise.all(messageIds.map(id => {
        const rawId = id.replace(/^(mail|sent|archive)-/, '');
        return api.archiveMail(rawId);
      }));
      await loadMessages();
      setSelectedMessageIds(prev => {
        const newSet = new Set(prev);
        messageIds.forEach(id => newSet.delete(id));
        return newSet;
      });
      if (selectedMessage && messageIds.includes(selectedMessage.id)) {
        setSelectedMessage(null);
      }
    } catch (error) {
      console.error('Failed to archive messages:', error);
    }
  }, [loadMessages, selectedMessage]);

  const getMessageIcon = (type: UnifiedMessage['type']) => {
    switch (type) {
      case 'mail': return <Mail className="h-4 w-4 text-blue-500" />;
      case 'sent': return <Mail className="h-4 w-4 text-green-500" />;
      case 'archive': return <Archive className="h-4 w-4 text-gray-500" />;
      case 'status-report': return <FileText className="h-4 w-4 text-yellow-500" />;
      case 'proposal': return <Vote className="h-4 w-4 text-purple-500" />;
      default: return <MessageSquare className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getMessageColor = (type: UnifiedMessage['type'], priority?: string, status?: string) => {
    if (priority === 'critical' || status === 'blocked') {
      return 'border-red-500/20 bg-red-500/5';
    }
    if (priority === 'high' || status === 'issues_found') {
      return 'border-orange-500/20 bg-orange-500/5';
    }

    switch (type) {
      case 'mail':
        return 'border-blue-500/20 bg-blue-500/5';
      case 'status-report':
        return 'border-green-500/20 bg-green-500/5';
      case 'proposal':
        return 'border-purple-500/20 bg-purple-500/5';
      default:
        return 'border-border bg-transparent';
    }
  };

  const getPriorityBadge = (priority?: string, status?: string) => {
    if (status === 'blocked') {
      return <span className="px-2 py-1 text-xs bg-red-500/20 text-red-400 rounded-full">Blocked</span>;
    }
    if (status === 'issues_found') {
      return <span className="px-2 py-1 text-xs bg-orange-500/20 text-orange-400 rounded-full">Issues</span>;
    }
    if (priority === 'critical') {
      return <span className="px-2 py-1 text-xs bg-red-500/20 text-red-400 rounded-full">Critical</span>;
    }
    if (priority === 'high') {
      return <span className="px-2 py-1 text-xs bg-yellow-500/20 text-yellow-400 rounded-full">High</span>;
    }
    return null;
  };

  const getTabCount = (type: MessageType) => {
    const filtered = messages.filter(msg => {
      if (type === 'all') return true;
      if (type === 'proposals') return msg.type === 'proposal';
      return msg.type === type.replace('-reports', '-report');
    });
    if (type === 'archive' || type === 'sent') {
      return filtered.length;
    }
    return filtered.filter(m => m.unread).length;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-8 w-8 animate-spin text-accent" />
        <span className="ml-2 text-muted-foreground">Loading messages...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
        <div className="flex">
          <AlertCircle className="h-4 w-4 text-destructive" />
          <div className="ml-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <div className="flex items-center justify-between p-6 border-b border-border bg-card">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Messaging</h1>
          <p className="text-muted-foreground">
            Unified inbox for mail, status reports, and proposals
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="ghost"
            onPress={() => setViewerExpanded(!viewerExpanded)}
            aria-label={viewerExpanded ? "Collapse viewer" : "Expand viewer"}
          >
            {viewerExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          <Button
            variant="primary"
            isDisabled={loading}
            onPress={loadMessages}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div
          className="bg-card border-r border-border flex flex-col"
          style={{ width: viewerExpanded ? '0px' : `${panelWidth}px`, minWidth: viewerExpanded ? '0px' : '300px' }}
        >
          <div className="border-b border-border p-2">
            <nav className="space-y-1">
              {[
                { key: 'all' as MessageType, label: 'All', icon: MessageSquare },
                { key: 'mail' as MessageType, label: 'Inbox', icon: Mail },
                { key: 'sent' as MessageType, label: 'Sent', icon: Mail },
                { key: 'archive' as MessageType, label: 'Archive', icon: Archive },
                { key: 'status-reports' as MessageType, label: 'Status Reports', icon: FileText },
                { key: 'proposals' as MessageType, label: 'Proposals', icon: Vote },
              ].map(({ key, label, icon: Icon }) => (
                <Button
                  key={key}
                  variant="ghost"
                  className="w-full justify-start"
                  onPress={() => setActiveTab(key)}
                >
                  <Icon className="h-4 w-4 mr-3" />
                  <span className="flex-1 text-left">{label}</span>
                  {(() => {
                    const count = getTabCount(key);
                    if (count === 0) return null;
                    return (
                      <span className="px-2 py-0.5 text-xs bg-primary text-primary-foreground rounded-full min-w-[20px] text-center">
                        {count}
                      </span>
                    );
                  })()}
                </Button>
              ))}
            </nav>
          </div>

          <div className="border-b border-border px-4 py-2 bg-muted/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  className="rounded border-border bg-background"
                  checked={filteredMessages.length > 0 && filteredMessages.every(m => selectedMessageIds.has(m.id))}
                  onChange={() => {
                    const allSelected = filteredMessages.every(m => selectedMessageIds.has(m.id));
                    if (allSelected) {
                      setSelectedMessageIds(prev => {
                        const newSet = new Set(prev);
                        filteredMessages.forEach(m => newSet.delete(m.id));
                        return newSet;
                      });
                    } else {
                      setSelectedMessageIds(prev => {
                        const newSet = new Set(prev);
                        filteredMessages.forEach(m => newSet.add(m.id));
                        return newSet;
                      });
                    }
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => handleMarkRead(filteredMessages.filter(m => m.unread).map(m => m.id), true)}
                  isDisabled={!filteredMessages.some(m => m.unread)}
                  className="text-muted-foreground"
                >
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Mark Read
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => handleArchive(Array.from(selectedMessageIds))}
                  isDisabled={selectedMessageIds.size === 0}
                  className="text-muted-foreground"
                >
                  <Archive className="h-3 w-3 mr-1" />
                  Archive
                </Button>
              </div>
              <div className="flex items-center space-x-1 text-sm text-muted-foreground">
                <span>{filteredMessages.length} messages</span>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {filteredMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center p-8">
                <MessageSquare className="h-16 w-16 text-muted mb-4" />
                <h3 className="text-lg font-medium text-foreground mb-2">
                  No {activeTab === 'all' ? '' : activeTab.replace('-', ' ')} messages
                </h3>
                <p className="text-muted-foreground max-w-sm">
                  {activeTab === 'all'
                    ? 'Messages from arms and the brain will appear here.'
                    : `${activeTab.replace('-', ' ')} will appear here as the system operates.`
                  }
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filteredMessages.map((message) => (
                  <div
                    key={message.id}
                    onClick={() => handleMessageClick(message)}
                    className={`p-4 cursor-pointer hover:bg-muted/20 transition-colors ${
                      selectedMessage?.id === message.id ? 'bg-secondary border-l-4 border-accent' : ''
                    } ${getMessageColor(message.type, message.priority, message.status)}`}
                  >
                    <div className="flex items-start space-x-3">
                      <div className="flex-shrink-0 mt-1">
                        <input
                          type="checkbox"
                          className="rounded border-border bg-background"
                          checked={selectedMessageIds.has(message.id)}
                          onChange={(e) => {
                            e.stopPropagation();
                            setSelectedMessageIds(prev => {
                              const newSet = new Set(prev);
                              if (newSet.has(message.id)) {
                                newSet.delete(message.id);
                              } else {
                                newSet.add(message.id);
                              }
                              return newSet;
                            });
                          }}
                        />
                      </div>
                      <div className="flex-shrink-0 mt-1">
                        {getMessageIcon(message.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center space-x-2 flex-1 min-w-0">
                            <h4 className={`text-sm font-medium truncate text-foreground ${message.unread ? 'font-semibold' : ''}`}>
                              {message.title}
                            </h4>
                            {getPriorityBadge(message.priority, message.status)}
                          </div>
                          <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">
                            {new Date(message.timestamp).toLocaleDateString()}
                          </span>
                          <span className="text-xs text-foreground font-bold ml-1">
                            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <p className={`text-sm text-muted-foreground line-clamp-2 ${message.unread ? 'font-medium text-foreground' : ''}`}>
                          {message.summary}
                        </p>
                        <div className="flex items-center justify-between mt-2">
                          <div className="flex items-center space-x-2">
                            {message.unread && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-accent/20 text-accent">
                                Unread
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {!viewerExpanded && (
          <div
            ref={resizeRef}
            className="w-1 bg-gray-200 cursor-col-resize hover:bg-gray-300 transition-colors"
            onMouseDown={() => setIsResizing(true)}
          />
        )}

        <div className={`flex-1 bg-background p-6 overflow-auto ${viewerExpanded ? 'block' : 'hidden md:block'}`}>
          {selectedMessage ? (
            <Card className="shadow-xl border-border/50">
              <Card.Header className="border-b border-border/50 bg-white pb-4">
                <div className="flex items-start justify-between w-full">
                  <div className="flex items-start space-x-3 flex-1">
                    <div className="mt-1 p-2 bg-background rounded-lg border border-border/50 shadow-sm">
                      {getMessageIcon(selectedMessage.type)}
                    </div>
                    <div className="flex-1">
                      <Card.Title className="text-xl font-semibold text-foreground mb-1">
                        {selectedMessage.title}
                      </Card.Title>
                      <Card.Description className="flex items-center space-x-2 text-sm mb-2">
                        <span>From: {selectedMessage.type === 'mail' ? selectedMessage.data.from : `System (${selectedMessage.data.armId || 'Brain'})`}</span>
                        <span className="text-muted-foreground">•</span>
                        <span className="text-muted-foreground">{new Date(selectedMessage.timestamp).toLocaleString()}</span>
                      </Card.Description>
                      <div className="flex items-center space-x-2">
                        {getPriorityBadge(selectedMessage.priority, selectedMessage.status)}
                        <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                          selectedMessage.unread ? 'bg-accent/20 text-accent' : 'bg-secondary text-secondary-foreground border border-border'
                        }`}>
                          {selectedMessage.unread ? 'Unread' : 'Read'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-1">
                    {(selectedMessage.type === 'mail' || selectedMessage.type === 'sent' || selectedMessage.type === 'archive') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() => openReply({
                          messageId: selectedMessage.data.id,
                          from: selectedMessage.data.from,
                          subject: selectedMessage.title,
                          body: selectedMessage.data.body,
                        })}
                      >
                        <Reply className="h-4 w-4 mr-1" />
                        Reply
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() => handleMarkRead([selectedMessage.id], selectedMessage.unread ?? false)}
                    >
                      {selectedMessage.unread ? <Eye className="h-4 w-4 mr-1" /> : <EyeOff className="h-4 w-4 mr-1" />}
                      {selectedMessage.unread ? 'Mark Read' : 'Mark Unread'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onPress={() => handleArchive([selectedMessage.id])}
                    >
                      <Archive className="h-4 w-4 mr-1" />
                      Archive
                    </Button>
                  </div>
                </div>
              </Card.Header>

              <Card.Content className="pt-6">
                <div className="prose prose-sm max-w-none">
                  {(selectedMessage.type === 'mail' || selectedMessage.type === 'sent' || selectedMessage.type === 'archive') ? (
                    <div className="whitespace-pre-wrap font-mono text-sm bg-slate-50 p-5 rounded-xl border border-border/50 text-foreground leading-relaxed">
                      {selectedMessage.data.body}
                    </div>
                  ) : selectedMessage.type === 'status-report' ? (
                    <div className="space-y-4">
                      <Card className="shadow-md border-border/30 bg-white">
                        <Card.Header>
                          <Card.Title className="text-base">Status Report Details</Card.Title>
                        </Card.Header>
                        <Card.Content className="space-y-3">
                          <div className="flex items-center justify-between py-2 border-b border-border/30">
                            <span className="text-muted-foreground text-sm">Arm</span>
                            <span className="font-medium text-sm">{selectedMessage.data.armId}</span>
                          </div>
                          <div className="flex items-center justify-between py-2 border-b border-border/30">
                            <span className="text-muted-foreground text-sm">Status</span>
                            <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                              selectedMessage.data.status === 'on_track' ? 'bg-green-500/20 text-green-400' :
                              selectedMessage.data.status === 'blocked' ? 'bg-red-500/20 text-red-400' :
                              selectedMessage.data.status === 'issues_found' ? 'bg-orange-500/20 text-orange-400' :
                              'bg-muted text-muted-foreground'
                            }`}>
                              {selectedMessage.data.status.replace('_', ' ').toUpperCase()}
                            </span>
                          </div>
                          <div className="py-2">
                            <span className="text-muted-foreground text-sm block mb-1">Summary</span>
                            <p className="text-sm">{selectedMessage.data.summary}</p>
                          </div>
                          {selectedMessage.data.issues && selectedMessage.data.issues.length > 0 && (
                            <div className="py-2 border-t border-border/30">
                              <span className="text-muted-foreground text-sm block mb-2">Issues</span>
                              <ul className="space-y-1">
                                {selectedMessage.data.issues.map((issue: string, i: number) => (
                                  <li key={i} className="flex items-start space-x-2 text-sm">
                                    <span className="text-orange-400 mt-1">•</span>
                                    <span>{issue}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {selectedMessage.data.blockers && selectedMessage.data.blockers.length > 0 && (
                            <div className="py-2 border-t border-border/30">
                              <span className="text-muted-foreground text-sm block mb-2">Blockers</span>
                              <ul className="space-y-1">
                                {selectedMessage.data.blockers.map((blocker: string, i: number) => (
                                  <li key={i} className="flex items-start space-x-2 text-sm">
                                    <span className="text-red-400 mt-1">•</span>
                                    <span>{blocker}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {selectedMessage.data.nextSteps && (
                            <div className="py-2 border-t border-border/30">
                              <span className="text-muted-foreground text-sm block mb-1">Next Steps</span>
                              <p className="text-sm">{selectedMessage.data.nextSteps}</p>
                            </div>
                          )}
                          {selectedMessage.data.filesChanged && selectedMessage.data.filesChanged.length > 0 && (
                            <div className="py-2 border-t border-border/30">
                              <span className="text-muted-foreground text-sm block mb-2">Files Changed</span>
                              <div className="flex flex-wrap gap-2">
                                {selectedMessage.data.filesChanged.map((file: string, i: number) => (
                                  <span key={i} className="font-mono text-xs bg-muted px-2 py-1 rounded border border-border/30">
                                    {file}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </Card.Content>
                      </Card>
                    </div>
                  ) : (
                    <div className="text-muted-foreground italic text-center py-8">
                      Proposal content would be displayed here.
                    </div>
                  )}
                </div>
              </Card.Content>
            </Card>
          ) : (
            <Card className="h-full flex flex-col items-center justify-center text-center shadow-lg border-border/30">
              <Card.Content className="py-16">
                <div className="p-4 bg-muted/30 rounded-full mb-4 inline-block">
                  <Mail className="h-12 w-12 text-muted-foreground" />
                </div>
                <Card.Title className="text-lg mb-2">No message selected</Card.Title>
                <Card.Description className="max-w-sm">
                  Select a message from the list to view its contents.
                </Card.Description>
              </Card.Content>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
