import { FastifyRequest, FastifyReply } from "fastify";
import { ZodSchema } from "zod";

export function validationMiddleware<T extends ZodSchema>(
  schema: T,
  type: "body" | "query" = "body",
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const data = type === "body" ? request.body : request.query;

    try {
      schema.parse(data);
    } catch (err: any) {
      // Send the error response directly
      return reply.status(400).send({
        error: "Validation failed",
        details: err.errors || err.message,
      });
    }
  };
}
