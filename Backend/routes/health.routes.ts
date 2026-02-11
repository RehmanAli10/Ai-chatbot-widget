import { FastifyInstance } from "fastify";

export async function healthRoute(fastify: FastifyInstance) {
  fastify.get("/", async () => {
    return {
      success: true,
      message: "Server is running",
      timestamp: new Date().toISOString(),
    };
  });
}
