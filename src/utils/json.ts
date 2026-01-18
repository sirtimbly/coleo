/**
 * Safe JSON parsing utilities
 * Addresses unsafe JSON.parse usage throughout the codebase
 */

export interface SafeParseResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Safely parse JSON with proper error handling
 */
export function safeJsonParse<T = unknown>(text: string): SafeParseResult<T> {
  try {
    const data = JSON.parse(text) as T;
    return { success: true, data };
  } catch (err) {
    return { 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown JSON parsing error' 
    };
  }
}

/**
 * Safely parse JSON with validation function
 */
export function safeJsonParseWithValidation<T>(
  text: string, 
  validator: (data: unknown) => data is T
): SafeParseResult<T> {
  const parseResult = safeJsonParse(text);
  
  if (!parseResult.success) {
    return { success: false, error: parseResult.error };
  }
  
  if (!validator(parseResult.data)) {
    return { 
      success: false, 
      error: 'JSON data failed validation' 
    };
  }
  
  return { success: true, data: parseResult.data as T };
}

/**
 * Type guard for BrainState
 */
export function isBrainState(data: unknown): data is Partial<import('../api/routes/brain').BrainState> {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  
  const obj = data as Record<string, unknown>;
  
  // Check required properties exist and have correct types
  if (obj.status !== undefined && typeof obj.status !== 'string') {
    return false;
  }
  
  if (obj.pollIntervalMs !== undefined && typeof obj.pollIntervalMs !== 'number') {
    return false;
  }
  
  if (obj.activeArms !== undefined && !Array.isArray(obj.activeArms)) {
    return false;
  }
  
  return true;
}