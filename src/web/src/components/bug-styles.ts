import type { Bug } from "@/lib/api";

export const STATUS_OPTIONS: Bug["status"][] = [
	"open",
	"investigating",
	"fixing",
	"verifying",
	"resolved",
	"closed",
];

export const STATUS_STYLES: Record<Bug["status"], string> = {
	open: "bg-red-900/30 text-red-300 border-red-800",
	investigating: "bg-yellow-900/30 text-yellow-300 border-yellow-800",
	fixing: "bg-blue-900/30 text-blue-300 border-blue-800",
	verifying: "bg-purple-900/30 text-purple-300 border-purple-800",
	resolved: "bg-green-900/30 text-green-300 border-green-800",
	closed: "bg-gray-800 text-gray-300 border-gray-700",
};

export const PRIORITY_OPTIONS: Bug["priority"][] = [
	"low",
	"medium",
	"high",
	"critical",
];

export const PRIORITY_STYLES: Record<Bug["priority"], string> = {
	low: "bg-emerald-900/30 text-emerald-300 border-emerald-800",
	medium: "bg-sky-900/30 text-sky-300 border-sky-800",
	high: "bg-amber-900/30 text-amber-300 border-amber-800",
	critical: "bg-rose-900/30 text-rose-300 border-rose-800",
};

export const SOURCE_STYLES: Record<Bug["source"], string> = {
	arm_reported: "bg-blue-900/30 text-blue-300 border-blue-800",
	human_reported: "bg-purple-900/30 text-purple-300 border-purple-800",
	system_detected: "bg-red-900/30 text-red-300 border-red-800",
};
