import type { OpenCodeEvent, PersistenceCheckResult } from "./event-stream-types";
import { truncateLargeFields } from "./event-utils";

export function filterEvent(event: OpenCodeEvent): { shouldBroadcast: boolean; eventName: string; data: Record<string, unknown> } {
  const type = event.type;
  const props = event.properties;

  const truncate = (data: Record<string, unknown>) => truncateLargeFields(data) as Record<string, unknown>;

  if (type === 'server.connected') {
    return { shouldBroadcast: false, eventName: '', data: {} };
  }

  if (type === 'session.updated' || type.startsWith('session.')) {
    return {
      shouldBroadcast: true,
      eventName: 'status',
      data: truncate({
        status: props.status || 'unknown',
        sessionId: props.id || props.sessionId,
        ...props,
      }),
    };
  }

  if (type.startsWith('message.')) {
    const info = props.info as Record<string, unknown> | undefined;
    const role = (info?.role as string) || (props.role as string) || 'unknown';
    return {
      shouldBroadcast: true,
      eventName: type.replace('message.', 'message-'),
      data: truncate({
        messageId: props.id || props.messageID,
        role,
        ...props,
      }),
    };
  }

  if (type.startsWith('part.')) {
    const partType = props.type as string || 'unknown';
    return {
      shouldBroadcast: true,
      eventName: `part-${partType}`,
      data: truncate({
        partId: props.id,
        partType,
        toolName: props.toolName || props.name,
        status: props.status,
        ...props,
      }),
    };
  }

  if (type.startsWith('todo.')) {
    return {
      shouldBroadcast: true,
      eventName: type,
      data: truncate(props),
    };
  }

  if (type.startsWith('file.')) {
    return {
      shouldBroadcast: true,
      eventName: type,
      data: truncate({
        path: props.path,
        ...props,
      }),
    };
  }

  return {
    shouldBroadcast: true,
    eventName: type.replace(/\./g, '-'),
    data: truncate(props),
  };
}

export function shouldPersistEvent(event: OpenCodeEvent): PersistenceCheckResult {
  const type = event.type;
  const props = event.properties || {};
  
  if (type === 'server.connected') {
    return { shouldPersist: false, reason: 'keepalive event' };
  }
  
  if (type === 'session.status') {
    return { shouldPersist: true, reason: 'session status change' };
  }
  
  if (type === 'session.idle') {
    return { shouldPersist: true, reason: 'session became idle' };
  }
  
  if (type === 'session.error') {
    return { shouldPersist: true, reason: 'session error' };
  }
  
  if (type === 'session.updated') {
    return { shouldPersist: true, reason: 'session metadata update' };
  }
  
  if (type === 'session.diff') {
    const diff = props.diff as Array<{ file?: string }> | undefined;
    if (diff && Array.isArray(diff) && diff.length > 0) {
      const fileChanges = diff.map(d => d.file).filter((f): f is string => !!f);
      return { 
        shouldPersist: true, 
        reason: 'file changes detected',
        fileChanges,
      };
    }
    return { shouldPersist: false, reason: 'empty session.diff' };
  }
  
  if (type === 'message.updated') {
    const info = props.info as Record<string, unknown> | undefined;
    if (!info) {
      return { shouldPersist: false, reason: 'message.updated without info' };
    }
    
    const time = info.time as { created?: number; completed?: number } | undefined;
    if (!time?.completed) {
      return { shouldPersist: false, reason: 'message.updated without completion time (streaming)' };
    }
    
    return {
      shouldPersist: true,
      reason: 'completed message',
      messageData: {
        messageId: info.id as string,
        role: info.role as string,
        modelId: info.modelID as string | undefined,
        providerId: info.providerID as string | undefined,
        agent: info.agent as string | undefined,
        completedAt: time.completed,
      },
    };
  }
  
  if (type === 'message.part.updated') {
    const part = props.part as Record<string, unknown> | undefined;
    if (!part) {
      return { shouldPersist: false, reason: 'message.part.updated without part data' };
    }
    
    const partType = part.type as string;
    
    if (partType === 'step-finish') {
      const tokens = part.tokens as {
        input?: number;
        output?: number;
        reasoning?: number;
        cache?: { read?: number; write?: number };
      } | undefined;
      
      return {
        shouldPersist: true,
        reason: 'step completion with token data',
        tokenData: {
          input: tokens?.input ?? 0,
          output: tokens?.output ?? 0,
          reasoning: tokens?.reasoning ?? 0,
          cacheRead: tokens?.cache?.read ?? 0,
          cacheWrite: tokens?.cache?.write ?? 0,
          cost: (part.cost as number) ?? 0,
        },
      };
    }
    
    return { shouldPersist: false, reason: `message.part.updated type=${partType} (streaming)` };
  }
  
  if (type === 'message.removed' || type === 'message.part.removed') {
    return { shouldPersist: true, reason: 'message/part removed' };
  }
  
  if (type === 'permission.asked' || type === 'permission.replied') {
    return { shouldPersist: true, reason: 'permission event' };
  }
  
  if (type === 'todo.updated') {
    return { shouldPersist: true, reason: 'todo list updated' };
  }
  
  if (type === 'file.edited') {
    const file = props.file as string | undefined;
    return { 
      shouldPersist: true, 
      reason: 'file edited',
      fileChanges: file ? [file] : undefined,
    };
  }

  if (type === 'file.read' || type === 'file.reads') {
    return { 
      shouldPersist: true, 
      reason: 'file read',
    };
  }
  
  if (type === 'file.watcher.updated') {
    return { shouldPersist: false, reason: 'file watcher noise' };
  }
  
  if (type === 'command.executed') {
    return { shouldPersist: true, reason: 'command executed' };
  }
  
  return { shouldPersist: false, reason: `unknown event type: ${type}` };
}
