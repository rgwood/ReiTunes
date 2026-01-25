/**
 * Remote logger that forwards console logs to the backend.
 * This allows viewing frontend logs alongside backend logs with `just logs`.
 */

type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let isEnabled = false;

function sendToBackend(level: LogLevel, args: unknown[]) {
  // Don't send if not enabled or if this looks like a Vite/React internal message
  if (!isEnabled) return;

  const message = args
    .map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');

  // Skip noisy internal messages
  if (message.includes('[vite]') || message.includes('[HMR]')) return;

  // Send asynchronously, don't wait for response
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      level: level === 'log' ? 'info' : level,
      message,
    }),
  }).catch(() => {
    // Silently ignore errors to avoid infinite loops
  });
}

function createWrapper(level: LogLevel) {
  return (...args: unknown[]) => {
    // Always call original console method
    originalConsole[level](...args);
    // Forward to backend
    sendToBackend(level, args);
  };
}

/**
 * Enable remote logging. Call this once at app startup.
 * Only enables in development mode.
 */
export function enableRemoteLogging() {
  // Only enable in development
  if (import.meta.env.PROD) return;

  if (isEnabled) return;
  isEnabled = true;

  console.log = createWrapper('log');
  console.info = createWrapper('info');
  console.warn = createWrapper('warn');
  console.error = createWrapper('error');
  console.debug = createWrapper('debug');

  // Log that we're enabled (this will be sent to backend too)
  console.info('[RemoteLogger] Frontend logging enabled');
}

/**
 * Disable remote logging and restore original console methods.
 */
export function disableRemoteLogging() {
  if (!isEnabled) return;
  isEnabled = false;

  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.debug = originalConsole.debug;
}
