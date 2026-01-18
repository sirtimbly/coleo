/**
 * Unified Messaging Page
 * Combines Mail, Status Reports, and Proposals in one interface
 */
import { useState, useEffect, useRef } from 'react';
import { api, type StatusReport, type MailMessage, useToast } from '@/lib';
import { RefreshCw, AlertCircle, Mail, FileText, Vote, MessageSquare, Archive, CheckCircle, Eye, EyeOff, Maximize2, Minimize2 } from 'lucide-react';

interface MessagingPageProps {}

type MessageType = 'all' | 'mail' | 'status-reports' | 'proposals';

interface UnifiedMessage {
  id: string;
  type: 'mail' | 'status-report' | 'proposal';
  timestamp: string;
  title: string;
  summary: string;
  status?: string;
  priority?: 'critical' | 'high' | 'normal' | 'low';
  unread?: boolean;
  data: any; // The original message data
}

export function MessagingPage({}: MessagingPageProps) {
  const [activeTab, setActiveTab] = useState<MessageType>('all');
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<UnifiedMessage | null>(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [panelWidth, setPanelWidth] = useState(400); // Width of message list panel
  const [isResizing, setIsResizing] = useState(false);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const [previousMessageCount, setPreviousMessageCount] = useState(0);
  const resizeRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  const loadMessages = async () => {
    try {
      setLoading(true);
      setError(null);

      // Note: Proposals API not implemented yet, will add when available
      const [mailResponse, statusReportsResponse] = await Promise.all([
        api.listInbox({ limit: 50 }),
        api.listStatusReports({ limit: 50 }),
      ]);

      const unifiedMessages: UnifiedMessage[] = [];

      // Add mail messages
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

      // Add status reports
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

      // Sort by timestamp (newest first)
      unifiedMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      setMessages(unifiedMessages);

      // Check for new messages and show toast
      const newMessageCount = unifiedMessages.length;
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

      setPreviousMessageCount(newMessageCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMessages();
  }, []);

  // Handle panel resizing
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
    if (activeTab === 'proposals') return msg.type === 'proposal'; // Placeholder for future
    return msg.type === activeTab.replace('-reports', '-report');
  });

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore if typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      if (!selectedMessage) return;

      const currentIndex = filteredMessages.findIndex(m => m.id === selectedMessage.id);
      if (currentIndex === -1) return;

      switch (e.key) {
        case 'j':
        case 'J':
          e.preventDefault();
          // Navigate to next message
          if (currentIndex < filteredMessages.length - 1) {
            handleMessageClick(filteredMessages[currentIndex + 1]);
          }
          break;
        case 'k':
        case 'K':
          e.preventDefault();
          // Navigate to previous message
          if (currentIndex > 0) {
            handleMessageClick(filteredMessages[currentIndex - 1]);
          }
          break;
        case 'e':
        case 'E':
          e.preventDefault();
          // Archive current message
          handleArchive([selectedMessage.id]);
          break;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedMessage, filteredMessages]);

  const handleMessageClick = (message: UnifiedMessage) => {
    setSelectedMessage(message);
    // Mark as read if it was unread
    if (message.unread) {
      setMessages(prev => prev.map(m =>
        m.id === message.id ? { ...m, unread: false } : m
      ));
    }
  };

  const handleMarkRead = (messageIds: string[], read: boolean) => {
    setMessages(prev => prev.map(m =>
      messageIds.includes(m.id) ? { ...m, unread: !read } : m
    ));
  };

  const handleArchive = (messageIds: string[]) => {
    // For now, just remove from the list (in future this would archive)
    setMessages(prev => prev.filter(m => !messageIds.includes(m.id)));

    // Clear selected message IDs
    setSelectedMessageIds(prev => {
      const newSet = new Set(prev);
      messageIds.forEach(id => newSet.delete(id));
      return newSet;
    });

    if (selectedMessage && messageIds.includes(selectedMessage.id)) {
      // Find the next message in the filtered list
      const currentIndex = filteredMessages.findIndex(m => m.id === selectedMessage.id);
      if (currentIndex >= 0) {
        const nextMessage = filteredMessages[currentIndex + 1] || filteredMessages[currentIndex - 1];
        if (nextMessage) {
          handleMessageClick(nextMessage);
        } else {
          setSelectedMessage(null);
        }
      } else {
        setSelectedMessage(null);
      }
    }
  };

  const getMessageIcon = (type: UnifiedMessage['type']) => {
    switch (type) {
      case 'mail':
        return <Mail className="h-4 w-4" />;
      case 'status-report':
        return <FileText className="h-4 w-4" />;
      case 'proposal':
        return <Vote className="h-4 w-4" />;
      default:
        return <MessageSquare className="h-4 w-4" />;
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
    return filtered.filter(m => m.unread).length; // Return unread count
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-8 w-8 animate-spin text-primary" />
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
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-border bg-card">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Messaging</h1>
          <p className="text-muted-foreground">
            Unified inbox for mail, status reports, and proposals
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setViewerExpanded(!viewerExpanded)}
            className="inline-flex items-center px-3 py-2 border border-border rounded-md text-sm font-medium text-muted-foreground bg-card hover:bg-secondary hover:text-secondary-foreground"
            title={viewerExpanded ? "Collapse viewer" : "Expand viewer"}
          >
            {viewerExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            onClick={loadMessages}
            disabled={loading}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-primary-foreground bg-primary hover:bg-primary/90 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Message List Panel */}
        <div
          className="bg-card border-r border-border flex flex-col"
          style={{ width: viewerExpanded ? '0px' : `${panelWidth}px`, minWidth: viewerExpanded ? '0px' : '300px' }}
        >
          {/* Filter Tabs - Vertical Layout */}
          <div className="border-b border-border p-2">
            <nav className="space-y-1">
              {[
                { key: 'all' as MessageType, label: 'All', icon: MessageSquare },
                { key: 'mail' as MessageType, label: 'Mail', icon: Mail },
                { key: 'status-reports' as MessageType, label: 'Status Reports', icon: FileText },
                { key: 'proposals' as MessageType, label: 'Proposals', icon: Vote },
              ].map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    activeTab === key
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4 mr-3" />
                  <span className="flex-1 text-left">{label}</span>
                  <span className="px-2 py-1 text-xs bg-muted rounded-full min-w-[20px] text-center">
                    {getTabCount(key)}
                  </span>
                </button>
              ))}
            </nav>
          </div>

          {/* Toolbar */}
          <div className="border-b border-border px-4 py-2 bg-muted/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    className="rounded border-border bg-background"
                    checked={filteredMessages.length > 0 && filteredMessages.every(m => selectedMessageIds.has(m.id))}
                    onChange={() => {
                      // Select/deselect all visible messages
                      const allSelected = filteredMessages.every(m => selectedMessageIds.has(m.id));
                      if (allSelected) {
                        // Deselect all
                        setSelectedMessageIds(prev => {
                          const newSet = new Set(prev);
                          filteredMessages.forEach(m => newSet.delete(m.id));
                          return newSet;
                        });
                      } else {
                        // Select all
                        setSelectedMessageIds(prev => {
                          const newSet = new Set(prev);
                          filteredMessages.forEach(m => newSet.add(m.id));
                          return newSet;
                        });
                      }
                    }}
                  />
                <button
                  onClick={() => handleMarkRead(filteredMessages.filter(m => m.unread).map(m => m.id), true)}
                  className="inline-flex items-center px-2 py-1 text-xs border border-border rounded text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
                  disabled={!filteredMessages.some(m => m.unread)}
                >
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Mark Read
                </button>
                <button
                  onClick={() => handleArchive(Array.from(selectedMessageIds))}
                  className="inline-flex items-center px-2 py-1 text-xs border border-border rounded text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
                  disabled={selectedMessageIds.size === 0}
                >
                  <Archive className="h-3 w-3 mr-1" />
                  Archive
                </button>
              </div>
              <div className="flex items-center space-x-1 text-sm text-muted-foreground">
                <span>{filteredMessages.length} messages</span>
              </div>
            </div>
          </div>

          {/* Message List */}
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
                    className={`p-4 cursor-pointer hover:bg-muted/50 transition-colors ${
                      selectedMessage?.id === message.id ? 'bg-secondary border-l-4 border-primary' : ''
                    } ${getMessageColor(message.type, message.priority, message.status)}`}
                  >
                    <div className="flex items-start space-x-3">
                      <div className="flex-shrink-0 mt-1">
                        <input
                          type="checkbox"
                          className="rounded border-border bg-background"
                          checked={selectedMessageIds.has(message.id)}
                          onChange={(e) => {
                            e.stopPropagation(); // Prevent message selection
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
                        </div>
                        <p className={`text-sm text-muted-foreground line-clamp-2 ${message.unread ? 'font-medium text-foreground' : ''}`}>
                          {message.summary}
                        </p>
                        <div className="flex items-center justify-between mt-2">
                          <div className="flex items-center space-x-2">
                            {message.unread && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/20 text-primary">
                                Unread
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Resizer */}
        {!viewerExpanded && (
          <div
            ref={resizeRef}
            className="w-1 bg-gray-200 cursor-col-resize hover:bg-gray-300 transition-colors"
            onMouseDown={() => setIsResizing(true)}
          />
        )}

        {/* Message Viewer Panel */}
        <div className={`flex-1 bg-card ${viewerExpanded ? 'block' : 'hidden md:block'}`}>
          {selectedMessage ? (
            <div className="h-full flex flex-col">
              {/* Message Header */}
              <div className="border-b border-border p-6 bg-muted/30">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-start space-x-3 flex-1">
                    {getMessageIcon(selectedMessage.type)}
                    <div className="flex-1">
                      <h2 className="text-xl font-semibold text-foreground mb-1">
                        {selectedMessage.title}
                      </h2>
                      <div className="flex items-center space-x-2 text-sm text-muted-foreground mb-2">
                        <span>From: {selectedMessage.type === 'mail' ? selectedMessage.data.from : `System (${selectedMessage.data.armId || 'Brain'})`}</span>
                        <span>•</span>
                        <span>{new Date(selectedMessage.timestamp).toLocaleString()}</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        {getPriorityBadge(selectedMessage.priority, selectedMessage.status)}
                        <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                          selectedMessage.unread ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                        }`}>
                          {selectedMessage.unread ? 'Unread' : 'Read'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => handleMarkRead([selectedMessage.id], selectedMessage.unread ?? false)}
                      className="inline-flex items-center px-3 py-2 border border-border rounded-md text-sm font-medium text-muted-foreground bg-card hover:bg-secondary hover:text-secondary-foreground"
                    >
                      {selectedMessage.unread ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                      {selectedMessage.unread ? 'Mark Read' : 'Mark Unread'}
                    </button>
                    <button
                      onClick={() => handleArchive([selectedMessage.id])}
                      className="inline-flex items-center px-3 py-2 border border-border rounded-md text-sm font-medium text-muted-foreground bg-card hover:bg-secondary hover:text-secondary-foreground"
                    >
                      <Archive className="h-4 w-4" />
                      Archive
                    </button>
                  </div>
                </div>
              </div>

              {/* Message Content */}
              <div className="flex-1 overflow-y-auto p-6">
                <div className="prose prose-sm max-w-none">
                  {selectedMessage.type === 'mail' ? (
                    <div className="whitespace-pre-wrap font-mono text-sm bg-muted p-4 rounded-lg text-foreground">
                      {selectedMessage.data.body}
                    </div>
                  ) : selectedMessage.type === 'status-report' ? (
                    <div className="space-y-4">
                      <div className="bg-secondary/50 border border-border rounded-lg p-4">
                        <h3 className="font-medium text-secondary-foreground mb-2">Status Report Details</h3>
                        <div className="space-y-2 text-sm text-foreground">
                          <p><strong className="text-muted-foreground">Arm:</strong> {selectedMessage.data.armId}</p>
                          <p><strong className="text-muted-foreground">Status:</strong> <span className={`px-2 py-1 rounded text-xs font-medium ${
                            selectedMessage.data.status === 'on_track' ? 'bg-green-500/20 text-green-400' :
                            selectedMessage.data.status === 'blocked' ? 'bg-red-500/20 text-red-400' :
                            selectedMessage.data.status === 'issues_found' ? 'bg-orange-500/20 text-orange-400' :
                            'bg-muted text-muted-foreground'
                          }`}>
                            {selectedMessage.data.status.replace('_', ' ').toUpperCase()}
                          </span></p>
                          <p><strong className="text-muted-foreground">Summary:</strong> {selectedMessage.data.summary}</p>
                          {selectedMessage.data.issues && selectedMessage.data.issues.length > 0 && (
                            <div>
                              <strong className="text-muted-foreground">Issues:</strong>
                              <ul className="list-disc list-inside mt-1 text-foreground">
                                {selectedMessage.data.issues.map((issue: string, i: number) => (
                                  <li key={i}>{issue}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {selectedMessage.data.blockers && selectedMessage.data.blockers.length > 0 && (
                            <div>
                              <strong className="text-muted-foreground">Blockers:</strong>
                              <ul className="list-disc list-inside mt-1 text-foreground">
                                {selectedMessage.data.blockers.map((blocker: string, i: number) => (
                                  <li key={i}>{blocker}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {selectedMessage.data.nextSteps && (
                            <p><strong className="text-muted-foreground">Next Steps:</strong> {selectedMessage.data.nextSteps}</p>
                          )}
                          {selectedMessage.data.filesChanged && selectedMessage.data.filesChanged.length > 0 && (
                            <div>
                              <strong className="text-muted-foreground">Files Changed:</strong>
                              <ul className="list-disc list-inside mt-1 text-foreground">
                                {selectedMessage.data.filesChanged.map((file: string, i: number) => (
                                  <li key={i} className="font-mono text-xs">{file}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-muted-foreground italic">
                      Proposal content would be displayed here.
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <Mail className="h-16 w-16 text-muted mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">
                No message selected
              </h3>
              <p className="text-muted-foreground max-w-sm">
                Select a message from the list to view its contents.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}