import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { BrainSettingSwitch } from './BrainSettingSwitch';
import { Search, Settings2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { BrainConfigResponse } from '@/lib/api';
import { BRAIN_RESPONSIBILITIES, JEV_TEMPLATES, builtinEnabled } from '../../../brain/responsibilities';
import type { ActionMode, BuiltinResponsibility, SwarmActionId } from '../../../brain/responsibilities';
import { BrainTemplatePreview } from './BrainTemplatePreview';
import './brain-settings.css';

const ACTION_LABELS: Record<SwarmActionId, string> = {
  prompt_arm: 'Prompt an arm', stop_arm: 'Stop an arm', update_task: 'Update a task', comment_task: 'Comment on a task',
  log_discovery: 'Log a discovery', create_bug: 'Create a bug', update_bug: 'Update a bug', notify_human: 'Notify the human',
  restart_dev_server: 'Restart a dev server', preserve_git_work: 'Preserve Git work',
};
function actionStatus(config: BrainConfigResponse, action: SwarmActionId): string {
  const choice = config.swarmActionModes?.[action] ?? 'inherit';
  if (choice === 'off') return 'Disabled';
  if (!config.swarmEvaluationMode || config.swarmEvaluationMode === 'off') return 'Waiting for global JEV evaluation';
  if (['restart_dev_server', 'preserve_git_work'].includes(action)) return 'Proposal only · execution not implemented';
  if (choice === 'shadow' || config.swarmEvaluationMode === 'shadow') return 'Proposals only';
  return 'Can execute · evidence and repeat checks apply';
}

export function BrainResponsibilities({ config, onSaved, children }: {
  config: BrainConfigResponse | null; onSaved: (config: BrainConfigResponse) => void; children: ReactNode;
}) {
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('overview');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const visible = BRAIN_RESPONSIBILITIES.filter(item =>
    `${item.title} ${item.today} ${item.actions.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const visibleIds = visible.map(item => item.id).join('|');
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const scroller = root.closest('[data-testid="brain-content"]');
    const observer = new IntersectionObserver(() => {
      const readingLine = (scroller?.getBoundingClientRect().top ?? 0) + 96;
      const sections = [...root.querySelectorAll<HTMLElement>('[data-responsibility]')];
      const current = sections.filter(section => section.getBoundingClientRect().top <= readingLine).at(-1);
      if (current) setActive(current.dataset.responsibility!);
    }, { root: scroller, rootMargin: '0px 0px -65% 0px', threshold: 0 });
    root.querySelectorAll('[data-responsibility]').forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, [visibleIds]);
  const jump = (id: string) => {
    setActive(id);
    const target = container.current?.querySelector<HTMLElement>(`[data-responsibility="${id}"]`);
    const scroller = container.current?.closest<HTMLElement>('[data-testid="brain-content"]');
    if (target && scroller) scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12 });
  };
  const save = async (update: Partial<BrainConfigResponse>, label: string) => {
    setSaving(true); setError(null); setNotice('Saving…');
    try {
      const result = await api.updateBrainConfig(update);
      onSaved(result.brain);
      setNotice(`${label} saved. The Brain reads this setting on its next decision.`);
    } catch (error) {
      setNotice('');
      setError(error instanceof Error ? error.message : 'Unable to save Brain settings');
    } finally { setSaving(false); }
  };
  return <div className="brain-settings" ref={container}>
    <aside className="brain-settings-index">
      <div className="brain-index-heading"><Settings2 size={16} /><span>Brain settings</span></div>
      <label className="brain-settings-search"><Search size={14} aria-hidden="true" /><input aria-label="Find a responsibility" placeholder="Find a responsibility…" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <nav aria-label="Brain responsibilities">
        <button type="button" aria-current={active === 'overview' ? 'location' : undefined} onClick={() => jump('overview')}>Overview &amp; models</button>
        {visible.map(item => <button type="button" key={item.id} aria-current={active === item.id ? 'location' : undefined} onClick={() => jump(item.id)}>{item.title}</button>)}
        <button type="button" aria-current={active === 'jev-prompts' ? 'location' : undefined} onClick={() => jump('jev-prompts')}>JEV policy &amp; questions</button>
      </nav>
      <p className="brain-index-note">Changes save immediately. Templates open in Plan &amp; Documents. Recommendations remain in Inbox → Brain → Decisions.</p>
    </aside>
    <div className="brain-settings-main">
      <section data-responsibility="overview" className="space-y-4">
        <header className="brain-settings-intro"><p className="brain-settings-eyebrow">Behavior, decisions &amp; prompts</p><h2>Customize your Brain</h2>
          <p>Choose which decisions the built-in handlers make and which actions JEV may take. Read the context and limits before switching a handler off.</p></header>
        {children}
        <div className="brain-settings-explainer"><strong>Two independent controls</strong><p>Built-in switches affect only the scope described in each section. JEV action choices apply across all sections that use that action and are limited by the global switches above. Turning a built-in handler off does not turn JEV on or provide an automatic fallback.</p><p>“Propose only” records recommendations without executing that action. JEV runs after existing handlers, so this is observation—not a controlled comparison on identical state. Core lifecycle rules remain in place.</p></div>
      </section>
      <div className="brain-settings-save" aria-live="polite">{error ? <span role="alert" className="text-danger">{error}</span> : <span>{notice}</span>}</div>
      {!visible.length && <p className="p-4 text-sm text-muted-foreground">No responsibilities match “{search}”.</p>}
      {visible.map(item => <section className="brain-responsibility" data-responsibility={item.id} key={item.id} aria-label={item.title}>
        <header><span className="brain-settings-eyebrow">{item.builtinLabel ? 'Configurable responsibility' : 'Existing workflow & additional coverage'}</span><h2>{item.title}</h2></header>
        <div className="brain-responsibility-today"><h3>What the Brain does today</h3><p>{item.today}</p></div>
        <div className="brain-responsibility-options">
          {item.builtinLabel ? <div className="brain-handler-control"><BrainSettingSwitch label={item.builtinLabel} disabled={!config || saving}
            selected={config ? builtinEnabled(config, item.id as BuiltinResponsibility) : true}
            onChange={enabled => { void save({ responsibilityEnabled: { [item.id]: enabled } }, item.builtinLabel!); }} /><span className="brain-control-kind">Built-in</span></div> : <p className="brain-fixed-handler">Existing workflow stays active · no replacement switch</p>}
          <p className="brain-control-scope">{item.scope}</p>
          {item.actions.map(action => <div className="brain-action-control" key={action}>
            <label><span>JEV · {ACTION_LABELS[action]}</span><select aria-label={`JEV ${ACTION_LABELS[action]}`} disabled={!config || saving} value={config?.swarmActionModes?.[action] ?? 'inherit'} onChange={event => {
              void save({ swarmActionModes: { [action]: event.target.value as ActionMode } }, ACTION_LABELS[action]);
            }}><option value="inherit">Use global JEV mode</option><option value="shadow">Propose only</option><option value="off">Disabled</option></select></label>
            <p>{config ? actionStatus(config, action) : 'Loading…'}</p>
          </div>)}
        </div>
        <div className="brain-fit-gap"><div><h3>Where JEV fits</h3><p>{item.fit}</p></div><div><h3>What is still missing</h3><p>{item.gap}</p></div></div>
        <details className="brain-example"><summary>Example to evaluate</summary><p>{item.example}</p></details>
        <div className="brain-template-list"><h3>Prompts &amp; message templates</h3><p>Hover or click to read the current file. Click Edit in the preview to customize it.</p><div>{item.templates.map(name => <BrainTemplatePreview name={name} key={name} />)}</div>
          {item.actions.length > 0 && <button type="button" className="brain-template-link" onClick={() => jump('jev-prompts')}>View shared JEV policy and questions ↓</button>}</div>
      </section>)}
      <section className="brain-responsibility" data-responsibility="jev-prompts" aria-label="JEV policy and questions">
        <header><span className="brain-settings-eyebrow">Shared by every JEV action</span><h2>JEV policy &amp; questions</h2></header>
        <p>The policy tells JEV how to interpret the swarm window. The questions file contains action descriptions, routing instructions, and the text behind each choice. You can customize that language while preserving the structured keys and placeholders.</p>
        <div className="brain-template-list"><div>{JEV_TEMPLATES.map(name => <BrainTemplatePreview name={name} key={name} />)}</div></div>
        <p className="brain-control-scope">Templates reload at the start of each evaluation. Invalid question JSON blocks evaluation and is rejected by the editor. Evidence targets, execution thresholds, repeat prevention and supported API operations remain enforced in code. Saving a template does not cancel an evaluation already in progress.</p>
      </section>
    </div>
  </div>;
}
