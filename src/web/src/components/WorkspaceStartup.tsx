import { Check, LoaderCircle } from 'lucide-react';

export function WorkspaceStartup({ elapsed }: { elapsed: number }) {
  return <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
    <section className="w-full max-w-md py-12" aria-labelledby="workspace-startup-title">
      <p className="text-xs font-semibold tracking-[0.2em] text-muted-foreground">COLEO / WORKSPACE</p>
      <h1 id="workspace-startup-title" className="mt-6 text-3xl font-semibold tracking-tight">Connecting your workspace</h1>
      <p role="status" aria-live="polite" className="mt-4 text-sm leading-6 text-muted-foreground">
        {elapsed >= 60 ? 'This is taking a little longer. We’re still checking, and your workspace will open automatically.'
          : 'Your workspace is awake. We’re connecting your tools and checking your project. Updates can take a little longer.'}
      </p>
      <ol className="my-8 divide-y divide-border text-sm" aria-label="Startup progress">
        <li className="flex items-center justify-between py-3">Start workspace <Check aria-label="Complete" className="h-4 w-4 text-success" /></li>
        <li className="flex items-center justify-between py-3">Connect your tools <LoaderCircle aria-label="In progress" className="h-4 w-4 animate-spin motion-reduce:animate-none text-accent" /></li>
        <li className="flex items-center justify-between py-3">Open workspace <span className="text-xs text-muted-foreground">Up next</span></li>
      </ol>
      <p className="font-mono text-xs text-muted-foreground">Checking automatically · {elapsed}s elapsed</p>
    </section>
  </main>;
}
