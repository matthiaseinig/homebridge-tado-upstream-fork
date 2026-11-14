// A short, secret-free description of an error for log lines about tokens and
// sessions: the HTTP status, a system error code, or a fixed phrase. Error text
// from libraries (JSON.parse, got) can quote the data it choked on, so it is
// never interpolated into those log lines.
export function describeError(error, depth = 0) {
  if (!error || depth > 5) return 'unexpected error';
  if (error.code === 'TADO_AUTH_REQUIRED') return String(error.message); // our own fixed text
  const status = error.response?.statusCode;
  if (Number.isInteger(status)) return `HTTP ${status}`;
  if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{2,30}$/.test(error.code)) return error.code;
  if (error.name === 'TimeoutError') return 'timeout';
  if (error.cause) return describeError(error.cause, depth + 1);
  return 'unexpected error';
}
