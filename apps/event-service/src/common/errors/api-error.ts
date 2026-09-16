import { GraphQLError } from 'graphql';

type ApiErrorCode =
  | 'BAD_USER_INPUT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_SERVER_ERROR';

export class ApiError extends GraphQLError {
  constructor(
    message: string,
    code: ApiErrorCode,
    details?: Record<string, unknown>,
  ) {
    super(message, {
      extensions: {
        code,
        ...(details && { details }),
      },
    });

    this.name = 'ApiError';
  }
}
