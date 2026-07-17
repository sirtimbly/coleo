import { useState, useEffect, useId } from 'react';
import { Button, Select, Label, ListBox } from '@heroui/react';
import { LayoutPanelTop, Monitor, Moon, PanelsTopLeft, Sun } from 'lucide-react';
import { api, useTheme } from '@/lib';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { usePageTitle } from '@/hooks/usePageTitle';
import { VERSION } from '@/version';

const themeOptions = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

export function SettingsPage() {
  usePageTitle('Coleo Observatory - Settings');

  const [apiKey, setApiKey] = useState(api.getApiKey() || '');
  const [saved, setSaved] = useState(false);
  const { theme, setTheme } = useTheme();
  const { layoutMode, setLayoutMode } = useLayoutMode();
  const themeLabelId = useId();
  const apiKeyLabelId = useId();
  const fromAddressLabelId = useId();
  const toAddressLabelId = useId();
  const providerLabelId = useId();
  
  const [mailProvider, setMailProvider] = useState<'cloudflare' | 'postmark'>('cloudflare');
  const [fromAddress, setFromAddress] = useState('');
  const [toAddress, setToAddress] = useState('');
  const [mailSaved, setMailSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const key = api.getApiKey();
    if (key) setApiKey(key);
    
    api.getMailConfig().then((res) => {
      if (res.mail) {
        setMailProvider(res.mail.provider || 'cloudflare');
        setFromAddress(res.mail.fromAddress || '');
        setToAddress(res.mail.toAddress || '');
      }
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, []);

  const handleSave = () => {
    api.setApiKey(apiKey);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = () => {
    api.clearApiKey();
    setApiKey('');
  };

  const handleSaveMail = async () => {
    try {
      await api.updateMailConfig({
        provider: mailProvider,
        fromAddress,
        toAddress,
      });
      setMailSaved(true);
      setTimeout(() => setMailSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save mail config:', err);
    }
  };

  if (loading) {
    return (
      <div className="px-6 py-6">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 px-6 py-6">
      <div className="border-b border-border pb-4">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Configure the workspace and system connections</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Customize the look and feel of the Observatory
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Select
              className="w-full max-w-xs"
              value={theme}
              onChange={(value) => setTheme(value as 'light' | 'dark' | 'system')}
            >
              <Label id={themeLabelId}>Theme</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {themeOptions.map((option) => (
                    <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                      <div className="flex items-center gap-2">
                        <option.icon className="h-4 w-4" />
                        {option.label}
                      </div>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Choose your preferred color scheme. "System" follows your device settings.
            </p>
          </div>

          <div className="space-y-3 border-t border-border/60 pt-4">
            <div>
              <Label>Workspace Layout</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Golden Workspace is now the default layout for new users. You can switch back to the classic sidebar layout here at any time.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <button
                type="button"
                onClick={() => setLayoutMode('golden')}
                className={`rounded-md border p-4 text-left transition-colors ${
                  layoutMode === 'golden'
                    ? 'border-accent bg-accent/10'
                    : 'border-border bg-surface hover:bg-surface-secondary'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <PanelsTopLeft className="h-4 w-4" />
                  Golden Workspace
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Multi-pane docked workspace with launcher-driven navigation.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setLayoutMode('classic')}
                className={`rounded-md border p-4 text-left transition-colors ${
                  layoutMode === 'classic'
                    ? 'border-accent bg-accent/10'
                    : 'border-border bg-surface hover:bg-surface-secondary'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <LayoutPanelTop className="h-4 w-4" />
                  Classic Layout
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Single-window layout with the permanent left navigation sidebar.
                </p>
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email Configuration</CardTitle>
          <CardDescription>
            Configure the email provider used for brain communication
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label htmlFor={providerLabelId} className="block text-sm font-medium mb-2">
              Provider
            </label>
            <select
              id={providerLabelId}
              value={mailProvider}
              onChange={(event) => setMailProvider(event.target.value as 'cloudflare' | 'postmark')}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="cloudflare">Cloudflare Email Service</option>
              <option value="postmark">Postmark</option>
            </select>
          </div>

          <div>
            <label htmlFor={fromAddressLabelId} className="block text-sm font-medium mb-2">
              From Address
            </label>
            <input
              id={fromAddressLabelId}
              type="email"
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              placeholder="brain@coleo.dev"
              className="w-full rounded-md border border-border bg-surface px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The sender address verified with the selected provider
            </p>
          </div>

          <div>
            <label htmlFor={toAddressLabelId} className="block text-sm font-medium mb-2">
              To Address
            </label>
            <input
              id={toAddressLabelId}
              type="email"
              value={toAddress}
              onChange={(e) => setToAddress(e.target.value)}
              placeholder="your-email@example.com"
              className="w-full rounded-md border border-border bg-surface px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Your email address where the brain sends notifications
            </p>
          </div>

          <div className="flex gap-2">
            <Button variant="primary" onPress={handleSaveMail}>
              {mailSaved ? 'Saved!' : 'Save Email Settings'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API Configuration</CardTitle>
          <CardDescription>
            Set your API key to authenticate with the Coleo server
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label htmlFor={apiKeyLabelId} className="block text-sm font-medium mb-2">
              API Key
            </label>
            <input
              id={apiKeyLabelId}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your API key"
              className="w-full rounded-md border border-border bg-surface px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Get your API key from the server startup output
            </p>
          </div>

          <div className="flex gap-2">
            <Button variant="primary" onPress={handleSave}>
              {saved ? 'Saved!' : 'Save'}
            </Button>
            <Button variant="secondary" onPress={handleClear}>
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Version</span>
            <span>{VERSION}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Documentation</span>
            <a href="http://localhost:5174" className="text-accent hover:underline">
              View Docs
            </a>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Repository</span>
            <a href="https://github.com/anomalyco/coleo" className="text-accent hover:underline">
              GitHub
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
