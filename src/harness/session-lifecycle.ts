export interface SessionMetadata {
  id?: string;
  title?: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

export function isColeoSessionForArm(session: SessionMetadata, armId: string): boolean {
  return session.title?.startsWith(`Coleo Arm: ${armId}`) ?? false;
}

export function shouldPruneSession(session: SessionMetadata, armId: string, keepSessionId: string): boolean {
  if (!session.id || session.id === keepSessionId) {
    return false;
  }
  return isColeoSessionForArm(session, armId);
}

export function selectSessionForRecovery(
  sessions: SessionMetadata[],
  armId: string,
): SessionMetadata | null {
  const candidates = sessions.filter(
    (session): session is SessionMetadata & { id: string } =>
      typeof session.id === "string" && isColeoSessionForArm(session, armId),
  );
  return candidates.reduce<SessionMetadata | null>((latest, session) => {
    if (!latest) return session;
    const latestTime = latest.time?.updated ?? latest.time?.created ?? 0;
    const sessionTime = session.time?.updated ?? session.time?.created ?? 0;
    return sessionTime >= latestTime ? session : latest;
  }, null);
}
