import { FastifyInstance } from "fastify";
import { z } from "zod";
import { ChatRequest, ChatResponse } from "../types/chat.types";
import { chatController } from "../controllers/chat.controller";
import { validationMiddleware } from "../middlewares/validation.middleware";

export async function chatRoutes(fastify: FastifyInstance) {
  // Validation schema for chat requests
  const chatSchema = z.object({
    sessionId: z.string().min(1, "sessionId is required"),
    message: z.string().min(1, "message is required"),
    patientId: z.number().optional().nullable(),
    bookingState: z
      .object({
        patientId: z.number().optional().nullable(),
        locationId: z.number().optional().nullable(),
        appointmentTypeId: z.number().optional().nullable(),
        selectedSlot: z
          .object({
            id: z.number(),
            start: z.string(),
            end: z.string(),
            practitionerId: z.number(),
            practitionerName: z.string().optional(),
          })
          .optional()
          .nullable(),
      })
      .optional()
      .nullable(),
    extra: z
      .object({
        practitionerId: z.number().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
      })
      .passthrough()
      .optional()
      .nullable(),
  });

  fastify.post<{ Body: ChatRequest; Reply: ChatResponse }>(
    "/chat",
    {
      preHandler: validationMiddleware(chatSchema, "body"),
    },
    async (request, reply) => {
      return chatController.handleMessage(request, reply);
    },
  );

  fastify.get<{ Params: { sessionId: string } }>(
    "/chat/history/:sessionId",
    async (request, reply) => {
      return chatController.getHistory(request, reply);
    },
  );

  fastify.delete<{ Params: { sessionId: string } }>(
    "/chat/session/:sessionId",
    async (request, reply) => {
      return chatController.clearSession(request, reply);
    },
  );

  fastify.get("/chat/sessions", async (request, reply) => {
    return chatController.getAllSessions(request, reply);
  });
}
