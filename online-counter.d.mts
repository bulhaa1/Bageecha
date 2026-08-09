import type { IncomingMessage, ServerResponse } from 'node:http'

export function onlineCounterMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void
