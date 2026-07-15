import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, EyeOff, LoaderCircle, X } from "lucide-react";
import { Button } from "@heroui/react";

import { api, type OpenCodeProvider } from "@/lib";
import { useToast } from "@/hooks/useToast";

interface ProviderSetupModalProps {
	agentId: string;
	agentHostname: string;
	initialProviderId: string | null;
	providers: OpenCodeProvider[];
	onClose: () => void;
	onSaved: (providers: OpenCodeProvider[]) => void;
}

export function ProviderSetupModal({
	agentId,
	agentHostname,
	initialProviderId,
	providers,
	onClose,
	onSaved,
}: ProviderSetupModalProps) {
	const [providerId, setProviderId] = useState(initialProviderId || "");
	const [apiKey, setApiKey] = useState("");
	const [showApiKey, setShowApiKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const { showError, showSuccess } = useToast();

	useEffect(() => {
		setProviderId(initialProviderId || providers[0]?.id || "");
		setApiKey("");
		setShowApiKey(false);
	}, [initialProviderId, providers]);

	const provider = useMemo(
		() => providers.find((entry) => entry.id === providerId) || null,
		[providerId, providers],
	);

	if (!initialProviderId || !provider) {
		return null;
	}

	const close = () => {
		if (!saving) onClose();
	};

	const save = async () => {
		if (!apiKey.trim()) return;

		setSaving(true);
		try {
			const response = await api.setAgentOpenCodeApiKey(agentId, provider.id, apiKey);
			onSaved(response.providers);
			showSuccess(`${provider.name} is ready on ${agentHostname}`, "Provider Connected");
			onClose();
		} catch (err) {
			showError(
				err instanceof Error ? err.message : "Failed to save the API key",
				"Provider Setup Failed",
			);
		} finally {
			setSaving(false);
		}
	};

	return createPortal(
		<div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
			<div
				className="absolute inset-0 bg-black/60 backdrop-blur-sm"
				onClick={close}
			/>
			<div className="relative w-full max-w-lg overflow-hidden rounded-lg border border-border bg-overlay text-foreground shadow-2xl">
				<div className="flex items-center justify-between border-b border-border px-4 py-3">
					<div>
						<h2 className="text-lg font-semibold">Connect {provider.name}</h2>
						<p className="text-sm text-muted-foreground">
							Credentials are saved on {agentHostname}.
						</p>
					</div>
					<button
						onClick={close}
						disabled={saving}
						className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-foreground disabled:opacity-50"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				<div className="space-y-4 p-4">
					<div>
						<label className="mb-2 block text-sm font-medium">Provider</label>
						<select
							value={providerId}
							onChange={(event) => {
								setProviderId(event.target.value);
								setApiKey("");
								setShowApiKey(false);
							}}
							disabled={saving}
							className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground disabled:opacity-50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
						>
							{providers.map((entry) => (
								<option key={entry.id} value={entry.id}>
									{entry.name}{entry.connected ? " · connected" : ""}
								</option>
							))}
						</select>
					</div>

					{provider.authMethod === "api-key" ? (
						<>
							<div>
								<label className="mb-2 block text-sm font-medium">API key</label>
								<div className="relative">
									<input
										type={showApiKey ? "text" : "password"}
										value={apiKey}
										onChange={(event) => setApiKey(event.target.value)}
										autoComplete="off"
										placeholder={`Paste your ${provider.name} API key`}
										className="w-full rounded-lg border border-border bg-surface-secondary py-2 pl-3 pr-10 text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
									/>
									<button
										type="button"
										onClick={() => setShowApiKey((current) => !current)}
										className="absolute inset-y-0 right-0 px-3 text-muted-foreground hover:text-foreground"
										aria-label={showApiKey ? "Hide API key" : "Show API key"}
									>
										{showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
									</button>
								</div>
							</div>
							<p className="text-xs text-muted-foreground">
								Coleo sends this once to the arm host over the authenticated command channel.
								It is stored in OpenCode&apos;s auth file with owner-only permissions.
							</p>
						</>
					) : (
						<div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
							{provider.authMethod === "oauth"
								? `${provider.name} uses an interactive OAuth login. `
								: `${provider.name} needs provider-specific interactive credentials. `}
							For now, run <code>opencode auth login</code> on <code>{agentHostname}</code>,
							then reopen this modal. OAuth needs a separate server-mediated browser/device-code flow.
						</div>
					)}
				</div>

				<div className="flex justify-end gap-2 border-t border-border bg-surface-secondary/60 px-4 py-3">
					<Button variant="ghost" onPress={close} isDisabled={saving}>
						{provider.authMethod === "api-key" ? "Cancel" : "Close"}
					</Button>
					{provider.authMethod === "api-key" && (
						<Button
							variant="primary"
							onPress={save}
							isDisabled={!apiKey.trim() || saving}
							className="gap-2"
						>
							{saving && <LoaderCircle className="h-4 w-4 animate-spin" />}
							{saving ? "Saving…" : "Save API Key"}
						</Button>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
