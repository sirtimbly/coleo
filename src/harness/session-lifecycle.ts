export interface SessionMetadata {
  id?: string;
  title?: string;
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
