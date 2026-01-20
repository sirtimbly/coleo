import { useState, useEffect } from 'react';
import { api } from '@/lib';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components';

export function SettingsPage() {
  const [apiKey, setApiKey] = useState(api.getApiKey() || '');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // Load saved key
    const key = api.getApiKey();
    if (key) setApiKey(key);
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

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gradient-heading">Settings</h1>
        <p className="text-muted-foreground">Configure the Observatory</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>API Configuration</CardTitle>
          <CardDescription>
            Set your API key to authenticate with the Octopai server
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your API key"
              className="w-full px-3 py-2 bg-secondary border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Get your API key from the server startup output
            </p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              {saved ? 'Saved!' : 'Save'}
            </button>
            <button
              onClick={handleClear}
              className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/80 transition-colors"
            >
              Clear
            </button>
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
            <span>0.1.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Documentation</span>
            <a href="http://localhost:5174" className="text-primary hover:underline">
              View Docs
            </a>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Repository</span>
            <a href="https://github.com/anomalyco/octopai" className="text-primary hover:underline">
              GitHub
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
