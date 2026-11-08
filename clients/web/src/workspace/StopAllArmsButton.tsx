import { useState } from "react";
import { LoaderCircle, Square } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { armsKeys } from "@/lib/queryKeys";
import { useToast } from "@/hooks/useToast";

export function StopAllArmsButton() {
  const [stopping, setStopping] = useState(false);
  const queryClient = useQueryClient();
  const { data: arms } = useQuery({
    queryKey: armsKeys.list(),
    queryFn: async () => (await api.listArms()).arms,
    refetchInterval: 5000,
  });
  const runningCount = arms?.filter(arm => arm.status === "starting" ||
    (arm.runtime?.hasRuntime ?? (arm.status !== "stopped" && arm.status !== "error"))).length;
  const disabled = stopping || runningCount === undefined || runningCount === 0;
  const { showError, showSuccess } = useToast();
  const stopAll = async () => {
    if (disabled || !window.confirm("Stop all arms? This interrupts current work and releases their file claims. Arm profiles are kept so you can start them again.")) return;
    setStopping(true);
    try {
      const result = await api.stopAllArms();
      if (result.failed.length) {
        showError(`${result.stopped} stopped. Could not confirm: ${result.failed.map(arm => `${arm.id}: ${arm.error}`).join("; ")}. Claims for unconfirmed arms are retained.`, "Some arms could not stop");
      } else {
        showSuccess(`All arms stopped. ${result.releasedClaims} file claims released. Arm profiles kept.`);
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "Could not stop arms", "Stop failed");
    } finally {
      await queryClient.invalidateQueries({ queryKey: armsKeys.all() });
      setStopping(false);
    }
  };
  return (
    <button type="button" className="golden-dock-button golden-dock-button--stop"
      onClick={() => void stopAll()} disabled={disabled} aria-busy={stopping}
      aria-label={stopping ? "Stopping all arms" : "Stop all arms"}
      title={runningCount === 0 ? "No running arms to stop" : "Stop all arms and release their file claims without deleting profiles"}>
      {stopping ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
      <span className="golden-dock-button-label">{stopping ? "Stopping…" : "Stop all"}</span>
      <span className="text-xs tabular-nums" aria-live="polite">{runningCount === undefined ? "…" : `${runningCount} running`}</span>
    </button>
  );
}
