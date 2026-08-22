import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.code(422).send({ error: 'validation_failed', details: error.issues }); return;
    }
    const candidate = error as { statusCode?: unknown };
    const status = typeof candidate.statusCode === 'number' ? candidate.statusCode : 500;
    const message = error instanceof Error ? error.message : 'unexpected error';
    void reply.code(status).send({ error: status === 500 ? 'internal_error' : message });
  });
}
