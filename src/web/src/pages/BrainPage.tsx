import { useEffect, useState, useCallback } from 'react';
import { Play, Square, Settings, RefreshCw, Terminal, Save, X, Edit2, FileCode, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '@/lib';
import type { OctopaiConfig, ArmConfigSummary, OpenCodeProvider } from '@/lib';
import { Card, CardHeader, CardTitle, CardContent, StatusBadge } from '@/components';
import { useWebSocket } from '@/hooks/useWebSocket';

interface BrainStatus {
  status: 'stopped' | 'running' | 'paused';
  lastPollAt: string | null;
  pollIntervalMs: number;
  activeArmsCount: number;
  pendingTasksCount: number;
  completedToday: number;
  uptime: number | null;
}

// Known harnesses
const KNOWN_HARNESSES = ['opencode', 'claude-code', 'aider'];
const TERMINAL_EMULATORS = ['auto', 'ghostty', 'iterm2', 'terminal', 'wezterm'] as const;

// Defaults Display Component (read-only view)
function DefaultsDisplay({ 
  config, 
  openCodeProviders,
  onEdit 
}: { 
  config: OctopaiConfig | null;
  openCodeProviders: OpenCodeProvider[];
  onEdit: () => void;
}) {
  const harness = config?.defaults?.harness || 'opencode';
  const provider = config?.defaults?.provider || '';
  const model = config?.defaults?.model || '';
  const contextBudget = config?.defaults?.contextBudget || 100000;

  // Find the provider name for display
  const getProviderDisplayName = (providerId: string) => {
    const providerInfo = openCodeProviders.find(p => p.id === providerId);
    return providerInfo?.name || providerId || 'Not set';
  };

  const isOpenCode = harness === 'opencode';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-6">
        <div>
          <p className="text-sm text-muted-foreground">Harness</p>
          <p className="text-lg font-medium">{harness}</p>
        </div>
        {isOpenCode && (
          <div>
            <p className="text-sm text-muted-foreground">Provider</p>
            <p className="text-lg font-medium">{getProviderDisplayName(provider)}</p>
          </div>
        )}
        <div>
          <p className="text-sm text-muted-foreground">Model</p>
          <p className="text-lg font-medium font-mono text-sm">{model || 'Not set'}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Context Budget</p>
          <p className="text-lg font-medium">{contextBudget.toLocaleString()}</p>
        </div>
      </div>
      <button
        onClick={onEdit}
        className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <Edit2 className="h-4 w-4" /> Edit
      </button>
    </div>
  );
}

// Defaults Edit Form Component
function DefaultsEditForm({
  initialConfig,
  openCodeProviders,
  connectedProviders,
  onSave,
  onCancel,
}: {
  initialConfig: OctopaiConfig['defaults'];
  openCodeProviders: OpenCodeProvider[];
  connectedProviders: string[];
  onSave: (defaults: OctopaiConfig['defaults']) => void;
  onCancel: () => void;
}) {
  // Use local state for form values - this ensures re-renders work properly
  const [harness, setHarness] = useState(initialConfig.harness || 'opencode');
  const [provider, setProvider] = useState(initialConfig.provider || 'github-copilot');
  const [model, setModel] = useState(initialConfig.model || '');
  const [contextBudget, setContextBudget] = useState(initialConfig.contextBudget || 100000);

  const isOpenCodeHarness = harness === 'opencode';
  const selectedProvider = openCodeProviders.find(p => p.id === provider);
  const availableModels = selectedProvider?.models || [];

  // When harness changes, reset provider/model if switching to/from opencode
  const handleHarnessChange = (newHarness: string) => {
    setHarness(newHarness);
    if (newHarness === 'opencode') {
      setProvider('github-copilot');
      setModel('claude-sonnet-4');
    }
  };

  // When provider changes, reset model to first available
  const handleProviderChange = (providerId: string) => {
    setProvider(providerId);
    const providerInfo = openCodeProviders.find(p => p.id === providerId);
    const firstModel = providerInfo?.models[0]?.id || '';
    setModel(firstModel);
  };

  // Handle save - pass current form values to parent
  const handleSave = () => {
    onSave({
      harness,
      provider,
      model,
      contextBudget,
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        {/* Harness Selection */}
        <div>
          <label className="text-sm text-muted-foreground block mb-1">Harness</label>
          <select
            value={harness}
            onChange={(e) => handleHarnessChange(e.target.value)}
            className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
          >
            {KNOWN_HARNESSES.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>

        {/* Provider Selection - Only shown for OpenCode harness */}
        {isOpenCodeHarness && (
          <div>
            <label className="text-sm text-muted-foreground block mb-1">Provider</label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
            >
              {openCodeProviders.length > 0 ? (
                openCodeProviders.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {connectedProviders.includes(p.id) ? ' (connected)' : ''}
                  </option>
                ))
              ) : (
                <>
                  <option value="github-copilot">GitHub Copilot</option>
                  <option value="opencode">OpenCode Zen</option>
                </>
              )}
            </select>
          </div>
        )}

        {/* Model Selection */}
        <div>
          <label className="text-sm text-muted-foreground block mb-1">Model</label>
          {isOpenCodeHarness && availableModels.length > 0 ? (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
            >
              {availableModels.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
              placeholder="model name"
            />
          )}
        </div>

        {/* Context Budget */}
        <div>
          <label className="text-sm text-muted-foreground block mb-1">Context Budget</label>
          <input
            type="number"
            value={contextBudget}
            onChange={(e) => setContextBudget(parseInt(e.target.value) || 100000)}
            className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
          />
        </div>
      </div>

      {/* Save/Cancel buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
        >
          <Save className="h-4 w-4" /> Save
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-2 px-3 py-1.5 bg-secondary rounded-md hover:bg-secondary/80"
        >
          <X className="h-4 w-4" /> Cancel
        </button>
      </div>
    </div>
  );
}

export function BrainPage() {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [config, setConfig] = useState<OctopaiConfig | null>(null);
  const [armConfigs, setArmConfigs] = useState<ArmConfigSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // OpenCode providers and models
  const [openCodeProviders, setOpenCodeProviders] = useState<OpenCodeProvider[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);

  // Edit mode state
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editedConfig, setEditedConfig] = useState<OctopaiConfig | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Arm config detail view
  const [selectedArmConfig, setSelectedArmConfig] = useState<string | null>(null);
  const [armConfigRaw, setArmConfigRaw] = useState<string>('');
  const [armConfigEditing, setArmConfigEditing] = useState(false);

  // Collapsible sections
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    brain: true,
    defaults: true,
    mail: false,
    terminal: false,
    armConfigs: true,
  });

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const loadData = useCallback(async () => {
    try {
      const [statusRes, configRes, armConfigsRes, providersRes] = await Promise.all([
        api.getBrainStatus(),
        api.getFullConfig(),
        api.listArmConfigs(),
        api.getOpenCodeProviders(),
      ]);
      setStatus(statusRes.brain as BrainStatus);
      setConfig(configRes.config);
      setEditedConfig(configRes.config);
      setArmConfigs(armConfigsRes.arms);
      setOpenCodeProviders(providersRes.providers);
      setConnectedProviders(providersRes.connected);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load brain status');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleWSMessage = useCallback((msg: { channel?: string; event?: string; data?: unknown }) => {
    if (msg.channel === 'brain') {
      loadData();
    }
  }, [loadData]);

  useWebSocket({
    channels: ['brain'],
    onMessage: handleWSMessage,
  });

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleStart = async () => {
    setActionLoading('start');
    try {
      await api.startBrain();
      loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to start brain');
    } finally {
      setActionLoading(null);
    }
  };

  const handleStop = async () => {
    if (!confirm('Are you sure you want to stop the brain? This will halt all task processing.')) return;
    setActionLoading('stop');
    try {
      await api.stopBrain();
      loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to stop brain');
    } finally {
      setActionLoading(null);
    }
  };

  const handleSaveConfig = async (section: keyof OctopaiConfig) => {
    if (!editedConfig) return;
    setSaveStatus(null);
    try {
      await api.updateConfig({ [section]: editedConfig[section] });
      setConfig(editedConfig);
      setEditingSection(null);
      setSaveStatus({ type: 'success', message: `${section} configuration saved` });
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Failed to save' });
    }
  };

  const handleSaveDefaults = async (defaults: OctopaiConfig['defaults']) => {
    setSaveStatus(null);
    try {
      await api.updateConfig({ defaults });
      // Update both config and editedConfig with new defaults
      setConfig(prev => prev ? { ...prev, defaults } : null);
      setEditedConfig(prev => prev ? { ...prev, defaults } : null);
      setEditingSection(null);
      setSaveStatus({ type: 'success', message: 'defaults configuration saved' });
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Failed to save' });
    }
  };

  const handleCancelEdit = () => {
    setEditedConfig(config);
    setEditingSection(null);
  };

  const loadArmConfig = async (filename: string) => {
    try {
      const res = await api.getArmConfig(filename);
      setSelectedArmConfig(filename);
      setArmConfigRaw(res.raw);
      setArmConfigEditing(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to load arm config');
    }
  };

  const saveArmConfig = async () => {
    if (!selectedArmConfig) return;
    try {
      await api.updateArmConfig(selectedArmConfig, { raw: armConfigRaw });
      setArmConfigEditing(false);
      setSaveStatus({ type: 'success', message: 'Arm config saved' });
      loadData(); // Refresh the list
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Failed to save arm config' });
    }
  };

  const formatUptime = (seconds: number | null | undefined) => {
    if (seconds === null || seconds === undefined) return '-';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const formatPollInterval = (ms: number) => {
    if (ms >= 60000) return `${ms / 60000} min`;
    if (ms >= 1000) return `${ms / 1000}s`;
    return `${ms}ms`;
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-secondary rounded w-48" />
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 bg-secondary rounded" />
            ))}
          </div>
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
            <p className="text-sm text-muted-foreground mt-2">
              Make sure the API server is running: <code>bun run server</code>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const getBrainStatusType = (status: string) => {
    if (status === 'running') return 'idle' as const;
    if (status === 'paused') return 'paused' as const;
    return 'stopped' as const;
  };

  const SectionHeader = ({ id, title, icon: Icon }: { id: string; title: string; icon: React.ComponentType<{ className?: string }> }) => (
    <button
      onClick={() => toggleSection(id)}
      className="flex items-center gap-2 w-full text-left"
    >
      {expandedSections[id] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      <Icon className="h-5 w-5" />
      <span>{title}</span>
    </button>
  );

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gradient-heading">Brain</h1>
          <p className="text-muted-foreground">Central coordinator status and configuration</p>
        </div>
        <div className="flex items-center gap-2">
          {saveStatus && (
            <span className={`text-sm ${saveStatus.type === 'success' ? 'text-green-500' : 'text-destructive'}`}>
              {saveStatus.message}
            </span>
          )}
          <button
            onClick={loadData}
            className="p-2 text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Status Card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            Brain Status
          </CardTitle>
          <StatusBadge status={getBrainStatusType(status?.status || 'stopped')} />
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-6">
            <div>
              <p className="text-sm text-muted-foreground">Status</p>
              <p className="text-2xl font-bold capitalize">{status?.status || 'unknown'}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Uptime</p>
              <p className="text-2xl font-bold">{formatUptime(status?.uptime)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Active Arms</p>
              <p className="text-2xl font-bold">{status?.activeArmsCount || 0}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Pending Tasks</p>
              <p className="text-2xl font-bold">{status?.pendingTasksCount || 0}</p>
            </div>
          </div>

          <div className="flex gap-3 mt-6 pt-6 border-t">
            {status?.status === 'running' ? (
              <button
                onClick={handleStop}
                disabled={actionLoading === 'stop'}
                className="flex items-center gap-2 px-4 py-2 bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 disabled:opacity-50"
              >
                <Square className="h-4 w-4" />
                {actionLoading === 'stop' ? 'Stopping...' : 'Stop Brain'}
              </button>
            ) : status?.status === 'paused' ? (
              <button
                onClick={handleStart}
                disabled={actionLoading === 'start'}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                {actionLoading === 'start' ? 'Resuming...' : 'Resume Brain'}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={actionLoading === 'start'}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                {actionLoading === 'start' ? 'Starting...' : 'Start Brain'}
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Brain Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>
            <SectionHeader id="brain" title="Brain Configuration" icon={Settings} />
          </CardTitle>
        </CardHeader>
        {expandedSections.brain && (
          <CardContent>
            {editingSection === 'brain' ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="text-sm text-muted-foreground">Poll Interval (ms)</label>
                    <input
                      type="number"
                      value={editedConfig?.brain.pollIntervalMs || 30000}
                      onChange={(e) => setEditedConfig(prev => prev ? {
                        ...prev,
                        brain: { ...prev.brain, pollIntervalMs: parseInt(e.target.value) || 30000 }
                      } : null)}
                      className="w-full mt-1 px-3 py-2 bg-secondary border border-border rounded-md"
                    />
                  </div>
                  <div>
                    <label className="text-sm text-muted-foreground">Max Arms</label>
                    <input
                      type="number"
                      value={editedConfig?.brain.maxArms || 8}
                      onChange={(e) => setEditedConfig(prev => prev ? {
                        ...prev,
                        brain: { ...prev.brain, maxArms: parseInt(e.target.value) || 8 }
                      } : null)}
                      className="w-full mt-1 px-3 py-2 bg-secondary border border-border rounded-md"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSaveConfig('brain')}
                    className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                  >
                    <Save className="h-4 w-4" /> Save
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="flex items-center gap-2 px-3 py-1.5 bg-secondary rounded-md hover:bg-secondary/80"
                  >
                    <X className="h-4 w-4" /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-6">
                  <div>
                    <p className="text-sm text-muted-foreground">Poll Interval</p>
                    <p className="text-lg font-medium">{formatPollInterval(config?.brain.pollIntervalMs || 30000)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Max Arms</p>
                    <p className="text-lg font-medium">{config?.brain.maxArms || 8}</p>
                  </div>
                </div>
                <button
                  onClick={() => setEditingSection('brain')}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  <Edit2 className="h-4 w-4" /> Edit
                </button>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Defaults Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>
            <SectionHeader id="defaults" title="Default Settings" icon={Settings} />
          </CardTitle>
        </CardHeader>
        {expandedSections.defaults && (
          <CardContent>
            {editingSection === 'defaults' && config ? (
              <DefaultsEditForm
                initialConfig={config.defaults}
                openCodeProviders={openCodeProviders}
                connectedProviders={connectedProviders}
                onSave={handleSaveDefaults}
                onCancel={handleCancelEdit}
              />
            ) : (
              <DefaultsDisplay
                config={config}
                openCodeProviders={openCodeProviders}
                onEdit={() => setEditingSection('defaults')}
              />
            )}
          </CardContent>
        )}
      </Card>

      {/* Terminal Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>
            <SectionHeader id="terminal" title="Terminal Settings" icon={Terminal} />
          </CardTitle>
        </CardHeader>
        {expandedSections.terminal && (
          <CardContent>
            {editingSection === 'terminal' ? (
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-muted-foreground">Terminal Emulator</label>
                  <select
                    value={editedConfig?.terminal.emulator || 'auto'}
                    onChange={(e) => setEditedConfig(prev => prev ? {
                      ...prev,
                      terminal: { ...prev.terminal, emulator: e.target.value as typeof TERMINAL_EMULATORS[number] }
                    } : null)}
                    className="w-full mt-1 px-3 py-2 bg-secondary border border-border rounded-md max-w-xs"
                  >
                    {TERMINAL_EMULATORS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSaveConfig('terminal')}
                    className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                  >
                    <Save className="h-4 w-4" /> Save
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="flex items-center gap-2 px-3 py-1.5 bg-secondary rounded-md hover:bg-secondary/80"
                  >
                    <X className="h-4 w-4" /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">Terminal Emulator</p>
                  <p className="text-lg font-medium">{config?.terminal.emulator || 'auto'}</p>
                </div>
                <button
                  onClick={() => setEditingSection('terminal')}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  <Edit2 className="h-4 w-4" /> Edit
                </button>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Arm Configuration Files */}
      <Card>
        <CardHeader>
          <CardTitle>
            <SectionHeader id="armConfigs" title="Arm Configuration Files" icon={FileCode} />
          </CardTitle>
        </CardHeader>
        {expandedSections.armConfigs && (
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Configuration templates for arms in <code className="bg-secondary px-1 rounded">~/.octopai/arms/</code>
            </p>

            <div className="grid grid-cols-2 gap-4">
              {/* List of arm configs */}
              <div className="space-y-2">
                {armConfigs.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No arm configs found</p>
                ) : (
                  armConfigs.map((arm) => (
                    <button
                      key={arm.filename}
                      onClick={() => loadArmConfig(arm.filename)}
                      className={`w-full text-left p-3 rounded-md border transition-colors ${
                        selectedArmConfig === arm.filename
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      <div className="font-medium">{arm.name}</div>
                      <div className="text-sm text-muted-foreground flex gap-3">
                        <span>{arm.domain}</span>
                        <span>{arm.harness}</span>
                        {arm.budget && <span>{arm.budget.toLocaleString()} tokens</span>}
                      </div>
                    </button>
                  ))
                )}
              </div>

              {/* Arm config editor */}
              <div className="border border-border rounded-md">
                {selectedArmConfig ? (
                  <div className="h-full flex flex-col">
                    <div className="flex items-center justify-between p-2 border-b border-border bg-secondary/50">
                      <span className="font-mono text-sm">{selectedArmConfig}</span>
                      <div className="flex gap-2">
                        {armConfigEditing ? (
                          <>
                            <button
                              onClick={saveArmConfig}
                              className="flex items-center gap-1 px-2 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
                            >
                              <Save className="h-3 w-3" /> Save
                            </button>
                            <button
                              onClick={() => {
                                setArmConfigEditing(false);
                                loadArmConfig(selectedArmConfig);
                              }}
                              className="flex items-center gap-1 px-2 py-1 text-sm bg-secondary rounded hover:bg-secondary/80"
                            >
                              <X className="h-3 w-3" /> Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setArmConfigEditing(true)}
                            className="flex items-center gap-1 px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
                          >
                            <Edit2 className="h-3 w-3" /> Edit
                          </button>
                        )}
                      </div>
                    </div>
                    <textarea
                      value={armConfigRaw}
                      onChange={(e) => setArmConfigRaw(e.target.value)}
                      readOnly={!armConfigEditing}
                      className={`flex-1 p-3 font-mono text-sm bg-background resize-none min-h-[300px] ${
                        armConfigEditing ? '' : 'cursor-default'
                      }`}
                      spellCheck={false}
                    />
                  </div>
                ) : (
                  <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                    Select an arm config to view
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Last Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Last Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last Poll</span>
              <span>
                {status?.lastPollAt
                  ? new Date(status.lastPollAt).toLocaleString()
                  : 'Never'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Completed Today</span>
              <span className="font-medium">{status?.completedToday || 0} tasks</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
