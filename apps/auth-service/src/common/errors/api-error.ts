import { GraphQLError } from 'graphql';

export type ApiErrorCode =
  | 'BAD_USER_INPUT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_SERVER_ERROR';

type ApiErrorOptions = {
  code: ApiErrorCode;
  details?: Record<string, unknown>;
  requestId?: string;
};

export class ApiError extends GraphQLError {
  constructor(message: string, options: ApiErrorOptions) {
    super(message, {
      extensions: {
        code: options.code,
        ...(options.details && { details: options.details }),
        ...(options.requestId && { requestId: options.requestId }),
      },
    });

    this.name = 'ApiError';
  }
}
