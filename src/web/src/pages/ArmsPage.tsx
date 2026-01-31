import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Coins, Zap } from 'lucide-react';
import { Card, Chip, Button } from '@heroui/react';
import { api, type Arm } from '@/lib';
import { StatusBadge } from '@/components';
import { useWebSocket } from '@/hooks/useWebSocket';

interface ArmEventData {
  arm?: Arm;
  id?: string;
  status?: string;
  changes?: Partial<Arm>;
}

export function ArmsPage() {
  document.title = "Coleo Observatory - Arms";
  const [arms, setArms] = useState<Arm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadArms = useCallback(async () => {
    try {
      const res = await api.listArms();
      setArms(res.arms);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load arms');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleWSMessage = useCallback((msg: { channel?: string; event?: string; data?: unknown }) => {
    if (msg.channel !== 'arms' || !msg.event || !msg.data) return;

    const data = msg.data as ArmEventData;

    switch (msg.event) {
      case 'arm.created':
        if (data.arm) {
          setArms((prev) => [...prev, data.arm as Arm]);
        }
        break;

      case 'arm.updated':
        if (data.arm) {
          setArms((prev) =>
            prev.map((arm) => (arm.id === data.arm?.id ? data.arm : arm))
          );
        }
        break;

      case 'arm.deleted':
        if (data.id) {
          setArms((prev) => prev.filter((arm) => arm.id !== data.id));
        }
        break;

      case 'arm.spawned':
      case 'arm.killed':
      case 'arm.prompt_sent':
        if (data.id && data.status) {
          setArms((prev) =>
            prev.map((arm) =>
              arm.id === data.id ? { ...arm, status: data.status as Arm['status'] } : arm
            )
          );
        }
        break;
    }
  }, []);

  useWebSocket({
    channels: ['arms'],
    onMessage: handleWSMessage,
  });

  useEffect(() => {
    loadArms();
  }, [loadArms]);

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this arm?')) return;
    try {
      await api.deleteArm(id);
      loadArms();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete arm');
    }
  };

  if (error) {
    return (
      <div className="p-8">
        <Card className="border-danger">
          <Card.Content>
            <p className="text-danger">{error}</p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Arms</h1>
          <p className="text-muted-foreground">Manage your AI agents</p>
        </div>
        <Button variant="primary">
          <Plus className="h-4 w-4" />
          Spawn Arm
        </Button>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="h-48">
              <Card.Content>
                <div className="h-full bg-muted animate-pulse rounded" />
              </Card.Content>
            </Card>
          ))}
        </div>
      ) : arms.length === 0 ? (
        <Card>
          <Card.Content className="py-12 text-center">
            <p className="text-muted-foreground mb-4">No arms registered yet</p>
            <code className="block p-4 bg-muted/20 rounded text-sm text-left max-w-md mx-auto">
              coleo arm spawn --name my-arm --agent opencode
            </code>
          </Card.Content>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {arms.map((arm) => (
            <Card key={arm.id}>
              <Card.Header className="flex flex-row items-start justify-between">
                <div>
                  <Card.Title className="flex items-center gap-2">
                    {arm.name}
                    <StatusBadge status={arm.status} />
                  </Card.Title>
                  <p className="text-sm text-muted-foreground mt-1">
                    {arm.harness}
                    {(arm.provider || arm.model) && (
                      <span className="block mt-1">
                        {arm.provider && <Chip size="sm" variant="soft">{arm.provider}</Chip>}
                        {arm.provider && arm.model && <span> · </span>}
                        {arm.model && <Chip size="sm" variant="soft" color="success">{arm.model}</Chip>}
                      </span>
                    )}
                  </p>
                </div>
                <Button
                  isIconOnly
                  variant="ghost"
                  size="sm"
                  onPress={() => handleDelete(arm.id)}
                  className="text-danger hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </Card.Header>
              <Card.Content>
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="flex justify-between text-muted-foreground mb-1">
                      <span>Context</span>
                      <span>
                        {arm.currentContextUsed.toLocaleString()} / {arm.contextBudget.toLocaleString()}
                      </span>
                    </div>
                    <div className="h-2 bg-default-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{
                          width: `${Math.min((arm.currentContextUsed / arm.contextBudget) * 100, 100)}%`,
                        }}
                      />
                    </div>
                  </div>

                  {(arm.totalTokens !== undefined || arm.totalCost !== undefined) && (
                    <div className="flex items-center gap-4 text-muted-foreground">
                      {arm.totalTokens !== undefined && (
                        <div className="flex items-center gap-1">
                          <Zap className="h-3 w-3" />
                          <span>{arm.totalTokens.toLocaleString()} tokens</span>
                        </div>
                      )}
                      {arm.totalCost !== undefined && arm.totalCost > 0 && (
                        <div className="flex items-center gap-1">
                          <Coins className="h-3 w-3" />
                          <span>${arm.totalCost.toFixed(4)}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {arm.currentTaskSubject && (
                    <div className="p-2 bg-default-100 rounded">
                      <div className="text-xs text-muted-foreground mb-1">Current task</div>
                      <div className="text-sm truncate">{arm.currentTaskSubject}</div>
                    </div>
                  )}

                  {arm.reputation !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Reputation</span>
                      <span className="font-medium">{arm.reputation}/100</span>
                    </div>
                  )}

                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last active</span>
                    <span>
                      {arm.lastActivityAt
                        ? new Date(arm.lastActivityAt).toLocaleString()
                        : 'Never'}
                    </span>
                  </div>
                </div>

                {arm.personality && (
                  <div className="mt-4 p-3 bg-default-100 rounded text-xs text-muted-foreground">
                    {arm.personality.slice(0, 150)}...
                  </div>
                )}
              </Card.Content>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
