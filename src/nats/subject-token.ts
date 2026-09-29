/** Encode an entity ID as one NATS subject token, preserving ordinary IDs. */
export function subjectToken(id: string): string {
  return encodeURIComponent(id).replace(/[.!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function decodeSubjectToken(token: string): string {
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}
