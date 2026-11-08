import { useState } from "react";
import { LoaderCircle, Square } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/useToast";

export function StopArmButton({ id, name }: { id: string; name: string }) {
  const [stopping, setStopping] = useState(false);
  const { showError, showSuccess } = useToast();
  const stop = async () => {
    if (stopping || !window.confirm(`Stop ${name}? Current work will be interrupted and file claims released. The arm profile is kept.`)) return;
    setStopping(true);
    try {
      await api.controlHarness(id, "kill");
      showSuccess(`${name} stopped. File claims released; profile kept.`);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Could not stop arm", "Stop failed");
    } finally { setStopping(false); }
  };
  return <button type="button" onClick={() => void stop()} disabled={stopping} aria-busy={stopping}
    aria-label={`Stop ${name}`}
    className="inline-flex h-7 items-center gap-1.5 px-2 text-sm text-danger hover:bg-surface-secondary focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60">
    {stopping ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
    {stopping ? "Stopping…" : "Stop"}
  </button>;
}
