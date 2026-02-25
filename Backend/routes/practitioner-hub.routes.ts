// routes/practitioner-hub.routes.ts

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { practitionerHubService } from "../services/practitioner-hub.service.js";
import {
  LocationsOptionsResponse,
  AppointmentTypesResponse,
  TimeSlotAvailabilityResponse,
} from "../types/practitioner-hub.types.js";
import { validationMiddleware } from "../middlewares/validation.middleware.js";

export async function practitionerHubRoutes(fastify: FastifyInstance) {
  // ── Existing routes (unchanged) ────────────────────────────────────────────

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
      const { locationId, appointmentTypeId } = request.query;
      const slots = await practitionerHubService.getAvailableSlots(
        locationId,
        appointmentTypeId,
      );
      return reply.send(slots);
    },
  );

  // ── NEW: Practitioner autocomplete search (uses in-memory cache) ───────────

  /**
   * GET /practitioners/search?q=<name fragment>
   *
   * Returns up to 10 practitioners whose name contains the query string.
   * Practitioners are fetched from the API once and cached for 1 hour.
   * All subsequent calls are pure in-memory — no API round-trips.
   */
  fastify.get<{ Querystring: { q?: string } }>(
    "/practitioners/search",
    async (request, reply) => {
      const q = (request.query.q ?? "").trim();
      const practitioners =
        await practitionerHubService.searchPractitionersByQuery(q);
      return reply.send({
        practitioners,
        total: practitioners.length,
        cachedAt: practitionerHubService.cacheMeta.fetchedAt,
      });
    },
  );

  /**
   * POST /practitioners/cache/refresh
   *
   * Forces the practitioner cache to reload from the API immediately.
   * Useful after adding or removing a practitioner without waiting for TTL.
   */
  fastify.post("/practitioners/cache/refresh", async (_request, reply) => {
    try {
      const result = await practitionerHubService.refreshCache();
      return reply.send({ success: true, ...result });
    } catch (err: any) {
      reply.code(500);
      return reply.send({
        success: false,
        error: err.message ?? "Cache refresh failed",
      });
    }
  });
}
