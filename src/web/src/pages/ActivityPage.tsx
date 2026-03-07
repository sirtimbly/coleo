import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { api, type ActivityEntry } from '@/lib';
import { Card, CardHeader, CardTitle, CardContent } from '@/components';

export function ActivityPage() {
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ limit: 50, offset: 0, total: 0 });

  const loadActivity = async (offset = 0) => {
    try {
      const res = await api.listActivity({ limit: 50, offset });
      setActivity(res.activity);
      setPagination(res.pagination);
    } catch (err) {
      console.error('Failed to load activity:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadActivity();
  }, []);

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gradient-heading">Activity</h1>
        <p className="text-muted-foreground">System activity log</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            Activity Log
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({pagination.total} total)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-12 bg-secondary rounded animate-pulse" />
              ))}
            </div>
          ) : activity.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No activity recorded yet
            </p>
          ) : (
            <div className="space-y-1">
              {activity.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-4 p-3 rounded hover:bg-secondary/50 transition-colors"
                >
                    <div className="h-2 w-2 rounded-full bg-accent flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">
                      <span className="font-medium">{entry.actor}</span>
                      <span className="text-muted-foreground"> {entry.action}</span>
                      {entry.target && (
                        <span className="text-muted-foreground"> on </span>
                      )}
                      {entry.target && (
                        <span className="font-mono text-xs">{entry.target}</span>
                      )}
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground flex-shrink-0">
                    {new Date(entry.timestamp).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {pagination.total > pagination.limit && (
            <div className="flex justify-center gap-2 mt-4 pt-4 border-t border-border">
              <Button
                variant="secondary"
                size="sm"
                onPress={() => loadActivity(Math.max(0, pagination.offset - pagination.limit))}
                isDisabled={pagination.offset === 0}
              >
                Previous
              </Button>
              <span className="px-3 py-1 text-sm text-muted-foreground">
                {pagination.offset + 1} - {Math.min(pagination.offset + pagination.limit, pagination.total)} of {pagination.total}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onPress={() => loadActivity(pagination.offset + pagination.limit)}
                isDisabled={pagination.offset + pagination.limit >= pagination.total}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
