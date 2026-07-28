import type { TaskAttachment } from "../types";
import type { RepositoryOnboardingOperation } from "../onboarding/types";
import type { WorkspaceOperation } from "../workspace";

/**
 * NATS Message Types for Octopai Distributed Arm Management
 * 
 * Topic Structure:
 *   octopai.agent.{agentId}.{action}     - Commands TO agents
 *   octopai.arm.{armId}.{event}          - Events FROM arms
 *   octopai.broadcast.{event}            - Broadcast to all
 */

// ============================================
// Agent Registration & Discovery
// ============================================

export interface AgentInfo {
  agentId: string;
  hostname: string;
  platform: NodeJS.Platform;
  startedAt: string;
  version: string;
  capabilities: string[];  // e.g., ["opencode-api", "opencode"]
  maxArms: number;
}

export interface AgentHeartbeat {
  agentId: string;
  timestamp: string;
  activeArms: string[];
  info?: AgentInfo;
  load: {
    cpu: number;
    memory: number;
  };
}

// ============================================
// Arm State
// ============================================

export type ArmStatus = 'starting' | 'idle' | 'busy' | 'paused' | 'error' | 'stopped' | 'running';

export interface ArmState {
  armId: string;
  agentId: string;
  name: string;
  domain: string;
  harness: string;
  status: ArmStatus;
  pid: number | null;
  port: number | null;
  provider: string | null;
  model: string | null;
  sessionId: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  error: string | null;
}

// ============================================
// Commands (API Server -> Agent)
// ============================================

export interface SpawnArmCommand {
  type: 'spawn';
  requestId: string;
  armId: string;
  name: string;
  domain: string;
  harness: string;
  provider?: string;
  model?: string;
  contextBudget?: number;
  personality?: string;
  convictions?: string[];
  workDir?: string;
  initialPrompt?: string;
}

export interface KillArmCommand {
  type: 'kill';
  requestId: string;
  armId: string;
}

export interface SendPromptCommand {
  type: 'prompt';
  requestId: string;
  armId: string;
  prompt: string;
  interrupt?: boolean;
  attachments?: TaskAttachment[];
}

export interface GetStateCommand {
  type: 'get_state';
  requestId: string;
  armId: string;
}

export interface ListArmsCommand {
  type: 'list_arms';
  requestId: string;
}

export interface AbortCommand {
  type: 'abort';
  requestId: string;
  armId: string;
}

export interface GetMessagesCommand {
  type: 'get_messages';
  requestId: string;
  armId: string;
  limit?: number;
}

export interface GetTodosCommand {
  type: 'get_todos';
  requestId: string;
  armId: string;
}

export interface WorkspaceCommand {
  type: 'workspace';
  requestId: string;
  operation: WorkspaceOperation;
}

export interface RepositoryOnboardingCommand {
  type: 'repository_onboarding';
  requestId: string;
  operation: RepositoryOnboardingOperation;
}

export interface GetOpenCodeProvidersCommand {
  type: 'get_opencode_providers';
  requestId: string;
}

export interface SetOpenCodeApiKeyCommand {
  type: 'set_opencode_api_key';
  requestId: string;
  providerId: string;
  apiKey: string;
}

export type AgentCommand = 
  | SpawnArmCommand 
  | KillArmCommand 
  | SendPromptCommand 
  | GetStateCommand 
  | ListArmsCommand
  | AbortCommand
  | GetMessagesCommand
  | GetTodosCommand
  | WorkspaceCommand
  | RepositoryOnboardingCommand
  | GetOpenCodeProvidersCommand
  | SetOpenCodeApiKeyCommand;

// ============================================
// Responses (Agent -> API Server)
// ============================================

export interface CommandResponse<T = unknown> {
  requestId: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface SpawnResponse {
  armId: string;
  pid: number;
  port: number | null;
  sessionId: string | null;
}

export interface ListArmsResponse {
  arms: ArmState[];
}

export interface GetMessagesResponse {
  messages: unknown[];
  sessionId: string | null;
}

export interface GetTodosResponse {
  todos: unknown[];
}

export interface OpenCodeProviderModel {
  id: string;
  name: string;
  cost?: number;
  pricing?: {
    input?: number;
    output?: number;
  };
}

export interface OpenCodeProviderInfo {
  id: string;
  name: string;
  models: OpenCodeProviderModel[];
  connected: boolean;
  authMethod: 'api-key' | 'oauth' | 'external';
}

export interface OpenCodeProvidersResponse {
  providers: OpenCodeProviderInfo[];
}

// ============================================
// Events (Agent -> API Server, broadcast)
// ============================================

export interface ArmSpawnedEvent {
  type: 'arm.spawned';
  armId: string;
  agentId: string;
  state: ArmState;
}

export interface ArmKilledEvent {
  type: 'arm.killed';
  armId: string;
  agentId: string;
}

export interface ArmStatusChangedEvent {
  type: 'arm.status_changed';
  armId: string;
  agentId: string;
  oldStatus: ArmStatus;
  newStatus: ArmStatus;
  error?: string;
}

export interface ArmActivityEvent {
  type: 'arm.activity';
  armId: string;
  agentId: string;
  activity: {
    type: string;
    data: unknown;
  };
}

export interface ArmLogEvent {
  type: 'arm.log';
  armId: string;
  agentId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

export interface AgentConnectedEvent {
  type: 'agent.connected';
  agent: AgentInfo;
}

export interface AgentDisconnectedEvent {
  type: 'agent.disconnected';
  agentId: string;
  reason?: string;
}

// ============================================
// Brain Messages (Arm -> Brain)
// ============================================

export interface BrainMessage {
  from: string;
  to: 'brain';
  type: string;
  payload: unknown;
  timestamp: string;
}


export interface ArmRecoveredEvent {
  type: 'arm.recovered';
  armId: string;
  agentId: string;
  state: ArmState;
}

export type ArmEvent = 
  | ArmSpawnedEvent 
  | ArmKilledEvent 
  | ArmRecoveredEvent
  | ArmStatusChangedEvent 
  | ArmActivityEvent
  | ArmLogEvent;

export type AgentEvent = 
  | AgentConnectedEvent 
  | AgentDisconnectedEvent;

export type OctopaiEvent = ArmEvent | AgentEvent;

// ============================================
// Topic Names
// ============================================

export const TOPICS = {
  // Agent registration
  AGENT_REGISTER: 'coleo.agent.register',
  AGENT_HEARTBEAT: 'coleo.agent.heartbeat',
  AGENT_DISCONNECT: 'coleo.agent.disconnect',
  
  // Commands to specific agent
  agentCommand: (agentId: string) => `coleo.agent.${agentId}.command`,
  agentResponse: (agentId: string, requestId: string) => `coleo.agent.${agentId}.response.${requestId}`,
  
  // Events from arms
  armEvent: (armId: string) => `coleo.arm.${armId}.event`,
  
  // Brain message queue (arms → brain)
  BRAIN_MESSAGES: 'coleo.brain.messages',
  
  // Broadcast channels
  BROADCAST_AGENTS: 'coleo.broadcast.agents',
  BROADCAST_ARMS: 'coleo.broadcast.arms',
  BROADCAST_ALL: 'coleo.broadcast.all',
} as const;
