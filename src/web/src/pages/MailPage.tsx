import { useEffect, useState, useCallback } from 'react';
import { Button, Chip } from '@heroui/react';
import { Mail, Send, Inbox, RefreshCw, Eye, Archive } from 'lucide-react';
import { api, type MailMessage } from '@/lib';
import { Card, CardHeader, CardTitle, CardContent } from '@/components';
import { useWebSocket } from '@/hooks/useWebSocket';

export function MailPage() {
  const [inbox, setInbox] = useState<{ messages: MailMessage[]; pagination: { unread: number } } | null>(null);
  const [sent, setSent] = useState<{ messages: MailMessage[] } | null>(null);
  const [archive, setArchive] = useState<{ messages: MailMessage[] } | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<MailMessage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'inbox' | 'sent' | 'archive'>('inbox');

  const loadMail = useCallback(async () => {
    try {
      const [inboxRes, sentRes, archiveRes] = await Promise.all([
        api.listInbox({ limit: 20 }),
        api.listSent({ limit: 20 }),
        api.listArchive({ limit: 20 }),
      ]);
      setInbox(inboxRes);
      setSent(sentRes);
      setArchive(archiveRes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mail');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleWSMessage = useCallback((msg: { channel?: string; event?: string; data?: unknown }) => {
    if (msg.channel === 'activity' && (msg.event as string)?.includes('mail')) {
      loadMail();
    }
  }, [loadMail]);

  useWebSocket({
    channels: ['activity'],
    onMessage: handleWSMessage,
  });

  useEffect(() => {
    loadMail();
  }, [loadMail]);

  const handleMarkRead = async (id: string) => {
    try {
      await api.markMailRead(id);
      loadMail();
    } catch (err) {
      console.error('Failed to mark as read:', err);
    }
  };

  const handleArchive = async (id: string) => {
    try {
      await api.archiveMail(id);
      setSelectedMessage(null);
      loadMail();
    } catch (err) {
      console.error('Failed to archive:', err);
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-secondary rounded w-48" />
          <div className="h-96 bg-secondary rounded" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <Card className="border-destructive">
          <CardContent>
            <p className="text-destructive">Error: {error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const messages = activeTab === 'inbox' ? inbox?.messages || [] : 
                   activeTab === 'sent' ? sent?.messages || [] :
                   archive?.messages || [];

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gradient-heading">Mail</h1>
          <p className="text-muted-foreground">Human-agent communication</p>
        </div>
        <Button
          variant="ghost"
          onPress={loadMail}
          aria-label="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-8">
        <div className="col-span-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between border-b">
            <div className="flex gap-2">
              <Button variant="primary" onPress={handleSave}>
                {saved ? 'Saved!' : 'Save'}
              </Button>
              <Button variant="secondary" onPress={handleClear}>
                Clear
              </Button>
            </div>
            </CardHeader>
            <CardContent className="p-0">
              {messages.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <Mail className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No messages</p>
                </div>
              ) : (
                <div className="divide-y">
                  {messages.map((msg) => (
                    <button
                      key={msg.id}
                      onClick={() => setSelectedMessage(msg)}
                      className={`w-full p-4 text-left hover:bg-secondary/50 transition-colors cursor-pointer ${
                          activeTab === 'inbox' && !msg.flags.seen ? 'bg-accent/5' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`font-medium truncate ${activeTab === 'inbox' && !msg.flags.seen ? '' : 'text-muted-foreground'}`}>
                              {msg.from}
                            </span>
                            {msg.flags.flagged && (
                              <span className="text-yellow-500">★</span>
                            )}
                          </div>
                          <p className="text-sm truncate text-muted-foreground">{msg.subject}</p>
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(msg.date)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div>
          <Card className="h-full">
            {selectedMessage ? (
              <>
                <CardHeader className="border-b">
                  <CardTitle className="text-lg font-medium truncate">{selectedMessage.subject}</CardTitle>
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>From: {selectedMessage.from}</span>
                    <span>To: {selectedMessage.to}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(selectedMessage.date).toLocaleString()}
                  </div>
                </CardHeader>
                <CardContent className="pt-4">
                  <pre className="whitespace-pre-wrap text-sm font-mono bg-secondary/50 p-4 rounded overflow-auto max-h-96">
                    {selectedMessage.body}
                  </pre>

                  {activeTab === 'inbox' && (
                    <div className="mt-4 flex gap-2">
                      {selectedMessage.flags.seen ? null : (
                        <button
                          onClick={() => handleMarkRead(selectedMessage.id)}
                          className="flex-1 flex items-center justify-center px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
                        >
                          <Eye className="h-4 w-4 mr-2" />
                          Mark as Read
                        </button>
                      )}
                      <button
                        onClick={() => handleArchive(selectedMessage.id)}
                        className="flex-1 flex items-center justify-center px-4 py-2 border border-input bg-background rounded-md hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
                      >
                        <Archive className="h-4 w-4 mr-2" />
                        Archive
                      </button>
                    </div>
                  )}
                </CardContent>
              </>
            ) : (
              <CardContent className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center">
                  <Mail className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>Select a message to read</p>
                </div>
              </CardContent>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
