import { Card, CardContent } from '@/components';

export function GardenPage() {
  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Garden</h1>
        <p className="text-muted-foreground">3D visualization of your codebase</p>
      </div>

      <Card>
        <CardContent className="py-24 text-center">
          <p className="text-muted-foreground mb-4">
            Garden visualization coming in Phase 2
          </p>
          <p className="text-sm text-muted-foreground">
            Using React Three Fiber for 3D rendering with radial coordinates
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
