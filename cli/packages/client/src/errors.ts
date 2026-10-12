import { Code, ConnectError } from '@connectrpc/connect';
import { ErrorDetailSchema, ErrorDetail_Reason } from './gen/yaaa/v1/errors_pb.js';
import type { Product } from './gen/yaaa/v1/common_pb.js';

/** The CLI's fixed exit codes. Agents branch on these; see site/public/agent.md. */
export const Exit = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  auth: 3,
  limits: 4,
  conflict: 5,
  notFound: 6,
  retryable: 10,
} as const;

export interface YaaaError {
  reason: string;
  message: string;
  metadata: Record<string, string>;
  exit: number;
  /** With STORE_UNSUPPORTED: similar products at stores yaaa can buy from. */
  alternatives?: Product[];
}

const byReason: Record<number, [string, number]> = {
  [ErrorDetail_Reason.INVALID_ARGUMENT]: ['INVALID_ARGUMENT', Exit.usage],
  [ErrorDetail_Reason.UNAUTHENTICATED]: ['UNAUTHENTICATED', Exit.auth],
  [ErrorDetail_Reason.LIMIT_EXCEEDED]: ['LIMIT_EXCEEDED', Exit.limits],
  [ErrorDetail_Reason.CONFLICT]: ['CONFLICT', Exit.conflict],
  [ErrorDetail_Reason.IDEMPOTENCY_KEY_REUSED]: ['IDEMPOTENCY_KEY_REUSED', Exit.conflict],
  [ErrorDetail_Reason.NOT_FOUND]: ['NOT_FOUND', Exit.notFound],
  [ErrorDetail_Reason.UNAVAILABLE]: ['UNAVAILABLE', Exit.retryable],
  [ErrorDetail_Reason.RATE_LIMITED]: ['RATE_LIMITED', Exit.retryable],
  [ErrorDetail_Reason.STORE_UNSUPPORTED]: ['STORE_UNSUPPORTED', Exit.conflict],
  [ErrorDetail_Reason.CLIENT_OUTDATED]: ['CLIENT_OUTDATED', Exit.conflict],
  [ErrorDetail_Reason.PRICE_OR_STOCK_CHANGED]: ['PRICE_OR_STOCK_CHANGED', Exit.conflict],
};

const byCode: Partial<Record<Code, [string, number]>> = {
  [Code.InvalidArgument]: ['INVALID_ARGUMENT', Exit.usage],
  [Code.Unauthenticated]: ['UNAUTHENTICATED', Exit.auth],
  [Code.NotFound]: ['NOT_FOUND', Exit.notFound],
  [Code.Aborted]: ['CONFLICT', Exit.conflict],
  [Code.AlreadyExists]: ['CONFLICT', Exit.conflict],
  [Code.FailedPrecondition]: ['CONFLICT', Exit.conflict],
  [Code.Unavailable]: ['UNAVAILABLE', Exit.retryable],
  [Code.DeadlineExceeded]: ['UNAVAILABLE', Exit.retryable],
  [Code.ResourceExhausted]: ['RATE_LIMITED', Exit.retryable],
  [Code.PermissionDenied]: ['PERMISSION_DENIED', Exit.usage],
};

/** Turns anything thrown by a call into a stable error with its exit code. */
export function toYaaaError(e: unknown): YaaaError {
  // The CLI's own errors raised inside a call (no account, a profile signed in to another API) arrive wrapped by
  // Connect; they keep their own reason and exit code.
  if (e instanceof ConnectError && e.cause instanceof CliError) return toYaaaError(e.cause);
  if (e instanceof ConnectError) {
    const detail = e.findDetails(ErrorDetailSchema)[0];
    if (detail && byReason[detail.reason]) {
      const [reason, exit] = byReason[detail.reason]!;
      const alternatives = detail.alternatives.length ? detail.alternatives : undefined;
      return { reason, message: detail.message || e.rawMessage, metadata: { ...detail.metadata }, exit, ...(alternatives ? { alternatives } : {}) };
    }
    const [reason, exit] = byCode[e.code] ?? ['UNEXPECTED', Exit.unexpected];
    const unreachable = e.code === Code.Unavailable || e.code === Code.Unknown;
    return {
      reason,
      message: unreachable && /ECONNREFUSED|fetch failed|connect/i.test(e.rawMessage)
        ? `Can't reach the yaaa API (${e.rawMessage}).`
        : e.rawMessage,
      metadata: {},
      exit: unreachable && reason === 'UNEXPECTED' ? Exit.retryable : exit,
    };
  }
  if (e instanceof CliError) return { reason: e.reason, message: e.message, metadata: e.metadata, exit: e.exit };
  const message = e instanceof Error ? e.message : String(e);
  return { reason: 'UNEXPECTED', message, metadata: {}, exit: Exit.unexpected };
}

/** An error raised by the CLI itself (bad flags, no account yet). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exit: number = Exit.usage,
    readonly reason: string = 'INVALID_ARGUMENT',
    readonly metadata: Record<string, string> = {},
  ) {
    super(message);
  }
}
