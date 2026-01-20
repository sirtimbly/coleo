import { Card, CardContent } from '@/components';

export function ProposalsPage() {
  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gradient-heading">Proposals</h1>
        <p className="text-muted-foreground">Governance and decision making</p>
      </div>

      <Card>
        <CardContent className="py-24 text-center">
          <p className="text-muted-foreground mb-4">
            Proposals view coming soon
          </p>
          <p className="text-sm text-muted-foreground">
            View and vote on arm proposals, deployments, and changes
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
