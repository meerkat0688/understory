/** Normalize provider/SDK errors (plain objects, nested message, Error). */
export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const obj = error as { message?: unknown; error?: unknown };
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
    if (obj.error && typeof obj.error === "object") {
      const nested = obj.error as { message?: unknown };
      if (typeof nested.message === "string" && nested.message.trim()) return nested.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }
  return String(error);
}

const CONTENT_FILTER_RE =
  /inappropriate content|content.?filter|content.?moderat|safety/i;

/** True when the upstream provider blocked the response as unsafe/inappropriate. */
export function isContentFilterError(error: unknown): boolean {
  return CONTENT_FILTER_RE.test(formatUnknownError(error));
}

/** Whether a failed mutate attempt is safe to retry on another model. */
export function canRetryMutationAfterError(
  filesChangedCount: number,
  writeAttempted = false
): boolean {
  return filesChangedCount === 0 && !writeAttempted;
}
