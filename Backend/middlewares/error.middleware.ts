import { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export function errorMiddleware(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  request.log.error(error);

  const statusCode = error.statusCode || 500;

  reply.status(statusCode).send({
    error: error.message || "Internal Server Error",
    statusCode,
  });
}
