/**
 * Logger utility that adds timestamps to all log messages.
 * Format: "HH:mm:ss dd/MM/yyyy"
 */

const getTimestamp = (): string => {
  const now = new Date();

  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();

  return `${hours}:${minutes}:${seconds} ${day}/${month}/${year}`;
};

export const logger = {
  log: (...args: any[]) => {
    console.log(`[${getTimestamp()}]`, ...args);
  },

  error: (...args: any[]) => {
    console.error(`[${getTimestamp()}]`, ...args);
  },

  warn: (...args: any[]) => {
    console.warn(`[${getTimestamp()}]`, ...args);
  },

  info: (...args: any[]) => {
    console.info(`[${getTimestamp()}]`, ...args);
  },

  debug: (...args: any[]) => {
    console.debug(`[${getTimestamp()}]`, ...args);
  },
};
