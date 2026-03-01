import type { ErrorType } from "./rate-limit.service";

export interface ExternalErrorClassification {
  type: string;
  status?: string;
  message: string;
  errorType?: ErrorType;
}

type ErrorLike = { stderr?: string; message?: string };

const extractExternalErrorString = (error: unknown): string => {
  const errorLike = error as ErrorLike;
  return errorLike.stderr || errorLike.message || String(error);
};

/**
 * Common error classification helpers
 */
const isRateLimitError = (error: string, lowerError: string): boolean => {
  return (
    error.includes("429") ||
    lowerError.includes("rate-limited") ||
    lowerError.includes("rate limit")
  );
};

const isNetworkError = (error: string, lowerError: string): boolean => {
  return (
    lowerError.includes("connection") ||
    lowerError.includes("timeout") ||
    lowerError.includes("timed out") ||
    lowerError.includes("giving up") ||
    error.includes("ECONNREFUSED")
  );
};

const isDnsError = (error: string, lowerError: string): boolean => {
  return (
    error.includes("ENOTFOUND") || lowerError.includes("getaddrinfo") || error.includes("ERR_DNS")
  );
};

export const classifyYoutubeSearchError = (error: unknown): ExternalErrorClassification => {
  const errorStr = extractExternalErrorString(error);
  const lowerErrorStr = errorStr.toLowerCase();

  if (isRateLimitError(errorStr, lowerErrorStr)) {
    return {
      type: "RATE_LIMITED",
      status: "429",
      message: "YouTube rate limited (429)",
      errorType: "RATE_LIMIT_429",
    };
  }

  if (errorStr.includes("403")) {
    return {
      type: "FORBIDDEN",
      status: "403",
      message: "Access forbidden (403)",
      errorType: "FORBIDDEN_403",
    };
  }
  if (errorStr.includes("404")) {
    return { type: "NOT_FOUND", status: "404", message: "Video not found (404)" };
  }
  if (errorStr.includes("502")) {
    return { type: "BAD_GATEWAY", status: "502", message: "YouTube gateway error (502)" };
  }
  if (errorStr.includes("503")) {
    return { type: "SERVICE_UNAVAILABLE", status: "503", message: "YouTube unavailable (503)" };
  }

  if (lowerErrorStr.includes("unavailable") || lowerErrorStr.includes("not available")) {
    return { type: "CONTENT_UNAVAILABLE", message: "Video content is unavailable" };
  }

  if (isNetworkError(errorStr, lowerErrorStr)) {
    return {
      type: "NETWORK_ERROR",
      message: "Network error: Connection timeout or read error",
      errorType: "CONNECTION_TIMEOUT",
    };
  }

  if (isDnsError(errorStr, lowerErrorStr)) {
    return {
      type: "DNS_ERROR",
      message: "DNS error: Cannot resolve YouTube domain",
      errorType: "CONNECTION_TIMEOUT",
    };
  }

  return { type: "UNKNOWN", message: errorStr.substring(0, 200) };
};

export const classifySoundCloudSearchError = (error: unknown): ExternalErrorClassification => {
  const errorStr = extractExternalErrorString(error);
  const lowerErrorStr = errorStr.toLowerCase();

  if (errorStr.includes("404")) {
    return { type: "NOT_FOUND", status: "404", message: "Track not found (404)" };
  }
  if (isRateLimitError(errorStr, lowerErrorStr)) {
    return {
      type: "RATE_LIMITED",
      status: "429",
      message: "Rate limited by SoundCloud (429)",
      errorType: "RATE_LIMIT_429",
    };
  }
  if (errorStr.includes("502")) {
    return { type: "BAD_GATEWAY", status: "502", message: "SoundCloud gateway error (502)" };
  }
  if (errorStr.includes("503")) {
    return {
      type: "SERVICE_UNAVAILABLE",
      status: "503",
      message: "SoundCloud service unavailable (503)",
    };
  }
  if (errorStr.includes("403")) {
    return {
      type: "FORBIDDEN",
      status: "403",
      message: "Access forbidden by SoundCloud (403)",
      errorType: "FORBIDDEN_403",
    };
  }
  if (errorStr.includes("401")) {
    return { type: "UNAUTHORIZED", status: "401", message: "Unauthorized access (401)" };
  }

  if (isNetworkError(errorStr, lowerErrorStr)) {
    return {
      type: "NETWORK_ERROR",
      message: "Network error: Connection timeout or read error",
      errorType: "CONNECTION_TIMEOUT",
    };
  }

  if (isDnsError(errorStr, lowerErrorStr)) {
    return {
      type: "DNS_ERROR",
      message: "DNS error: Cannot resolve SoundCloud domain",
      errorType: "CONNECTION_TIMEOUT",
    };
  }

  if (lowerErrorStr.includes("not available")) {
    return { type: "NOT_AVAILABLE", message: "Track not available on SoundCloud" };
  }
  if (lowerErrorStr.includes("no matching")) {
    return { type: "NO_RESULTS", message: "No matching tracks found" };
  }

  return { type: "UNKNOWN", message: errorStr.substring(0, 200) };
};

export const classifyYoutubeDownloadError = (error: string): ExternalErrorClassification => {
  const lowerError = error.toLowerCase();

  if (isRateLimitError(error, lowerError)) {
    return {
      type: "RATE_LIMITED",
      message: "YouTube rate limited",
      errorType: "RATE_LIMIT_429",
    };
  }

  if (isNetworkError(error, lowerError) || isDnsError(error, lowerError)) {
    return {
      type: "CONNECTION_ERROR",
      message: "Network connection error or timeout",
      errorType: "CONNECTION_TIMEOUT",
    };
  }

  return { type: "UNKNOWN", message: error };
};

export const classifySoundCloudDownloadError = (error: unknown): ExternalErrorClassification => {
  const errorStr = extractExternalErrorString(error);
  const lowerErrorStr = errorStr.toLowerCase();

  if (isRateLimitError(errorStr, lowerErrorStr)) {
    return {
      type: "RATE_LIMITED",
      status: "429",
      message: "SoundCloud rate limited (429)",
      errorType: "RATE_LIMIT_429",
    };
  }

  if (errorStr.includes("403")) {
    return {
      type: "FORBIDDEN",
      status: "403",
      message: "Access forbidden by SoundCloud (403)",
      errorType: "FORBIDDEN_403",
    };
  }

  if (isNetworkError(errorStr, lowerErrorStr)) {
    return {
      type: "NETWORK_ERROR",
      message: "Network error: Connection timeout or read error",
      errorType: "CONNECTION_TIMEOUT",
    };
  }

  if (isDnsError(errorStr, lowerErrorStr)) {
    return {
      type: "DNS_ERROR",
      message: "DNS error: Cannot resolve SoundCloud domain",
      errorType: "CONNECTION_TIMEOUT",
    };
  }

  return { type: "UNKNOWN", message: errorStr.substring(0, 200) };
};
