export const HISTORY_TRUNCATION_LABEL = "[History truncated]";

export type HistoryPayloadShapeOptions = {
  limit?: number;
  maxContentChars?: number;
  maxDetailChars?: number;
  maxRawChars?: number;
};

export function truncateHistoryText(value: unknown, maxChars: number | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  if (maxChars === undefined) {
    return value;
  }
  if (maxChars <= 0) {
    return "";
  }
  if (value.length <= maxChars) {
    return value;
  }

  const suffix = `\n\n${HISTORY_TRUNCATION_LABEL}`;
  const budget = Math.max(0, maxChars - suffix.length);
  if (budget === 0) {
    return HISTORY_TRUNCATION_LABEL.slice(0, maxChars);
  }

  const prefix = value.slice(0, budget).trimEnd();
  return prefix ? `${prefix}${suffix}` : HISTORY_TRUNCATION_LABEL.slice(0, maxChars);
}

export function shapeHistoryPayload(payload: unknown, options: HistoryPayloadShapeOptions = {}): unknown {
  if (!Array.isArray(payload)) {
    return payload;
  }

  const limitedEntries =
    typeof options.limit === "number" && payload.length > options.limit
      ? payload.slice(-options.limit)
      : payload;

  return limitedEntries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }

    const next = { ...(entry as Record<string, unknown>) };
    const hasDetails = Object.prototype.hasOwnProperty.call(next, "details_text");
    const hasRawContent = Object.prototype.hasOwnProperty.call(next, "raw_content");
    const originalContent = typeof next.content === "string" ? next.content : "";
    const originalDetails = typeof next.details_text === "string" ? next.details_text : "";
    const truncatedContent = truncateHistoryText(originalContent, options.maxContentChars);
    const detailsSource = originalDetails || (truncatedContent !== originalContent ? originalContent : "");

    next.content = truncatedContent;
    if (hasDetails || detailsSource) {
      next.details_text = truncateHistoryText(detailsSource, options.maxDetailChars);
    }
    if (hasRawContent) {
      next.raw_content = truncateHistoryText(next.raw_content, options.maxRawChars);
    }
    return next;
  });
}
