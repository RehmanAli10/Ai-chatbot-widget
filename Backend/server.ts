import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";

import { chatRoutes } from "./routes/chat.routes";
import { practitionerHubRoutes } from "./routes/practitioner-hub.routes";
import { errorMiddleware } from "./middlewares/error.middleware";
import { config } from "./config/env.config";
import { healthRoute } from "./routes/health.routes";

dotenv.config();

async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: config.server.env === "development" ? "info" : "error",
      transport:
        config.server.env === "development"
          ? {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "HH:MM:ss Z",
                ignore: "pid,hostname",
              },
            }
          : undefined,
    },
  });

  // CORS
  await fastify.register(cors, {
    origin: config.cors.allowedOrigins,
    credentials: true,
  });

  // Routes
  await fastify.register(chatRoutes, { prefix: "/api" });
  await fastify.register(practitionerHubRoutes, { prefix: "/api" });
  await fastify.register(healthRoute);

  // Global error handler
  fastify.setErrorHandler(errorMiddleware);

  return fastify;
}

async function start() {
  try {
    const app = await buildApp();

    await app.listen({
      port: config.server.port,
      host: config.server.host,
    });

    console.log(
      `Server running at http://${config.server.host}:${config.server.port}`,
    );
    console.log(`Environment: ${config.server.env}`);
    console.log(`OpenAI Model: ${config.openai.model}`);
    console.log(`Practitioner Hub: ${config.practitionerHub.baseUrl}`);
    console.log("\nReady to accept requests!");
  } catch (err) {
    console.error("❌ Error starting server:", err);
    process.exit(1);
  }
}

start();
