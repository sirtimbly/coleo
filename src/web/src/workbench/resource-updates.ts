/**
 * Update contracts shared by sheets and dedicated detail projections.
 *
 * These types live outside legacy row components so active routes do not pull
 * one-off grid implementations into the production bundle just to share types.
 */

import type {
	Bug,
	BugMetadata,
	Task,
	TaskMetadata,
} from "@/lib";

export type TaskUpdate = Partial<{
	subject: string;
	description: string;
	status: Task["status"];
	priority: Task["priority"];
	domain: string;
	phase: string;
	assignedTo: string | null;
	dueDate: string | null;
	progress: number;
	artifacts: string[];
	metadata: TaskMetadata;
	blockedReason: string;
	blockedCategory: Task["blockedCategory"];
	blockedNeedsHuman: boolean;
}>;

export type BugUpdate = Partial<{
	title: string;
	description: string;
	status: Bug["status"];
	priority: Bug["priority"];
	assigneeArmId: string;
	blockers: string[];
	resolution: string;
	humanNotified: boolean;
	metadata: BugMetadata;
}>;
