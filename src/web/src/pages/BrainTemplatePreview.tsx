import { useEffect, useState } from 'react';
import { Button, Popover } from '@heroui/react';
import { FileCode2, ArrowUpRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useWorkspaceOpenRoute } from '@/workspace/route-context';

export function BrainTemplatePreview({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openRoute = useWorkspaceOpenRoute();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    void api.getBrainTemplate(name).then(result => {
      if (!cancelled) setContent(result.content);
    }).catch((error: unknown) => {
      if (!cancelled) setError(error instanceof Error ? error.message : 'Unable to load template');
    });
    return () => { cancelled = true; };
  }, [name, open]);
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Popover.Trigger className="brain-template-trigger" onMouseEnter={() => setOpen(true)} aria-label={`Preview ${name}`}>
        <FileCode2 size={14} aria-hidden="true" />{name}
      </Popover.Trigger>
      <Popover.Content placement="bottom start" className="w-[640px] max-w-[calc(100vw-2rem)]">
        <Popover.Dialog aria-label={`Template ${name}`} className="space-y-3 p-2 outline-none">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="break-all font-mono text-xs">{name}</h3>
            <Button size="sm" variant="secondary" onPress={() => {
              setOpen(false);
              openRoute({ pathname: '/setup', search: `?file=${encodeURIComponent(`.coleo/src/brain/templates/${name}`)}`, title: 'Plan & Documents' }, 'tab');
            }}>Edit in Plan &amp; Documents <ArrowUpRight size={14} /></Button>
          </div>
          <p className="text-xs text-muted-foreground">Current template text. Runtime state fills in placeholders when the Brain uses it.
            {name.startsWith('jev-') ? ' JEV templates reload each evaluation. Keep JSON keys and placeholder names intact.' : ' Edits apply the next time this template is loaded.'}</p>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : content === null ? <p role="status">Loading template…</p> :
            <pre tabIndex={0} className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary p-3 font-mono text-xs leading-relaxed">{content}</pre>}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
