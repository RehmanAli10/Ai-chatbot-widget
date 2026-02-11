import { FastifyInstance } from "fastify";
import { z } from "zod";
import { practitionerHubService } from "../services/practitioner-hub.service";
import {
  LocationsOptionsResponse,
  AppointmentTypesResponse,
  TimeSlotAvailabilityResponse,
} from "../types/practitioner-hub.types";
import { validationMiddleware } from "../middlewares/validation.middleware";

export async function practitionerHubRoutes(fastify: FastifyInstance) {
  fastify.get<{ Reply: LocationsOptionsResponse }>(
    "/locations",
    async (_request, reply) => {
      const locations = await practitionerHubService.getLocations();
      return reply.send(locations);
    },
  );

  fastify.get<{ Reply: AppointmentTypesResponse }>(
    "/appointment-types",
    async (_request, reply) => {
      const types = await practitionerHubService.getAppointmentTypes();
      return reply.send(types);
    },
  );

  const availableSlotsQuerySchema = z.object({
    locationId: z.string().min(1, "locationId is required"),

    appointmentTypeId: z.coerce.number(),

    start: z.string().min(1, "start is required"),
    end: z.string().min(1, "end is required"),
  });

  fastify.get<{
    Querystring: {
      locationId: string;
      appointmentTypeId: number;
      start: string;
      end: string;
    };
    Reply: TimeSlotAvailabilityResponse;
  }>(
    "/available-slots",
    {
      preHandler: validationMiddleware(availableSlotsQuerySchema, "query"),
    },
    async (request, reply) => {
      const { locationId, appointmentTypeId, start, end } = request.query;

      const slots = await practitionerHubService.getAvailableSlots(
        locationId,
        appointmentTypeId,
      );

      return reply.send(slots);
    },
  );
}
