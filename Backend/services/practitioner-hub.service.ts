import { practitionerHubClient } from "../config/practitioner-hub.config.js";
import {
  AppointmentTypesResponse,
  TimeSlotAvailabilityResponse,
  TimeSlot,
  LocationsOptionsResponse,
  CreateAppointmentSuccessResponse,
  CreateAppointmentRequest,
  PractitionerSearchResult,
  PractitionersResponse,
} from "../types/practitioner-hub.types.js";

import { getDateRange } from "../utils/helpers.js";

// ── Practitioner cache types ──────────────────────────────────────────────────
interface CachedPractitioner {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
}

interface CacheState {
  data: CachedPractitioner[];
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class PractitionerHubService {
  // ── Practitioner list cache (singleton per service instance) ───────────────
  private cache: CacheState = {
    data: [],
    fetchedAt: null,
    loading: false,
    error: null,
  };
  private fetchPromise: Promise<void> | null = null;

  // ── Private: fetch all practitioners and store in cache ───────────────────
  private async populateCache(): Promise<void> {
    if (this.fetchPromise) return this.fetchPromise; // deduplicate concurrent calls

    this.fetchPromise = (async () => {
      this.cache.loading = true;
      this.cache.error = null;

      try {
        console.log("[PractitionerCache] Fetching all practitioners from API…");

        const response = await practitionerHubClient.get<PractitionersResponse>(
          "/practitioners",
          {
            params: {
              online_booking: "eq:1",
            },
          },
        );

        const raw = response.data?.data ?? [];

        this.cache.data = raw
          .filter((p) => p.first_name && p.last_name)
          .map((p) => ({
            id: Number(p.id),
            firstName: p.first_name,
            lastName: p.last_name,
            name: `${p.first_name} ${p.last_name}`,
          }));

        this.cache.fetchedAt = Date.now();
        console.log(
          `[PractitionerCache] Cached ${this.cache.data.length} practitioners.`,
        );
      } catch (err: any) {
        this.cache.error = err.message ?? "Unknown error";
        this.cache.data = [];
        this.cache.fetchedAt = null;
        console.error("[PractitionerCache] Fetch failed:", this.cache.error);
      } finally {
        this.cache.loading = false;
        this.fetchPromise = null;
      }
    })();

    return this.fetchPromise;
  }

  // ── Private: ensure cache is populated and fresh ──────────────────────────
  private async ensureCacheFresh(): Promise<void> {
    const expired =
      this.cache.fetchedAt === null ||
      Date.now() - this.cache.fetchedAt > CACHE_TTL_MS;

    if (expired && !this.cache.loading) {
      await this.populateCache();
    } else if (this.cache.loading && this.fetchPromise) {
      await this.fetchPromise;
    }
  }

  // ── Public: warm cache at server startup ──────────────────────────────────
  async warmCache(): Promise<void> {
    console.log("[PractitionerCache] Warming cache at startup…");
    await this.populateCache();
  }

  // ── Public: search practitioners from cache (used by autocomplete) ─────────
  // Fetches from API on first call, then serves from memory.
  async searchPractitionersByQuery(
    query: string,
  ): Promise<CachedPractitioner[]> {
    await this.ensureCacheFresh();

    if (!query || query.trim().length === 0) return [];

    const q = query.trim().toLowerCase();
    return this.cache.data
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 10);
  }

  // ── Public: force cache refresh (admin endpoint) ───────────────────────────
  async refreshCache(): Promise<{ count: number; cachedAt: string }> {
    this.cache.fetchedAt = null; // mark stale
    await this.populateCache();
    return {
      count: this.cache.data.length,
      cachedAt: this.cache.fetchedAt
        ? new Date(this.cache.fetchedAt).toISOString()
        : "unavailable",
    };
  }

  get cacheMeta() {
    return {
      count: this.cache.data.length,
      fetchedAt: this.cache.fetchedAt
        ? new Date(this.cache.fetchedAt).toISOString()
        : null,
      error: this.cache.error,
    };
  }

  // ── Existing methods (unchanged) ───────────────────────────────────────────

  // Search practitioners by exact first and last name (used by AI chat flow)
  async searchPractitioners(
    firstName: string,
    lastName: string,
  ): Promise<PractitionerSearchResult> {
    if (!firstName || !lastName) {
      throw new Error(
        "Missing required fields: firstName and lastName are required",
      );
    }

    try {
      console.log(`Searching practitioners by name: ${firstName} ${lastName}`);

      const response = await practitionerHubClient.get<PractitionersResponse>(
        "/practitioners",
        {
          params: {
            first_name: `eq:${firstName}`,
            last_name: `eq:${lastName}`,
            active: "eq:1",
            online_booking: "eq:1",
          },
        },
      );

      console.log(
        `Practitioner search result for ${firstName} ${lastName}:`,
        response.data,
      );

      const practitioners = (response.data?.data || []).map((p) => ({
        id: p.id,
        name: `${p.first_name} ${p.last_name}`,
        firstName: p.first_name,
        lastName: p.last_name,
      }));

      return { practitioners };
    } catch (error: any) {
      console.error(
        "Error searching practitioners:",
        error.response?.data || error.message,
      );

      if (error.response) {
        throw new Error(
          `Practitioner Hub API error: ${error.response.status} - ${
            error.response.data?.message || error.message
          }`,
        );
      }

      throw new Error(`Failed to search practitioners: ${error.message}`);
    }
  }

  // Get available slots for appointment types
  async getAvailableSlots(
    locationId: string,
    appointmentTypeId: number,
    practitionerId?: number,
  ): Promise<TimeSlotAvailabilityResponse> {
    if (!locationId || !appointmentTypeId) {
      throw new Error(
        "Missing required fields: locationId and appointmentTypeId",
      );
    }

    try {
      console.log(
        `Searching slots for location ${locationId}, appointment type ${appointmentTypeId}`,
      );

      const { start, end } = getDateRange(14, true);
      console.log(`Searching current week: ${start} to ${end}`);

      const params: Record<string, any> = {
        location_id: locationId,
        appointment_type_id: appointmentTypeId,
        start,
        end,
      };

      if (practitionerId) {
        params.practitioner_id = practitionerId;
      }

      const response = await practitionerHubClient.get(
        "/timeslot_availability",
        { params },
      );

      const availableTimeSlots: TimeSlot[] = (
        response.data?.available ?? []
      ).map((slot: any) => ({
        id: slot.id,
        start: slot.start,
        end: slot.end,
        title: slot.title,
        practitionerId: slot.practitioner_id,
        practitionerName: slot.practitioner_name,
      }));

      const unavailableDates: string[] = response.data?.unavailable ?? [];

      console.log(`Found ${availableTimeSlots.length} slots in current week`);

      return { availableTimeSlots, unavailableDates };
    } catch (error: any) {
      console.error(
        "Error getting available slots:",
        error.response?.data || error.message,
      );

      if (error.response) {
        throw new Error(
          `Practitioner Hub API error: ${error.response.status} - ${
            error.response.data?.message || error.message
          }`,
        );
      }

      throw new Error(`Failed to get available slots: ${error.message}`);
    }
  }

  // Get appointment types
  async getAppointmentTypes(): Promise<AppointmentTypesResponse> {
    try {
      const appointmentTypes = [
        { id: 1, type: "ONE Adjustment" },
        { id: 2, type: "Initial Assessment (1st Visit)" },
      ];

      return { appointmentTypes };
    } catch (error: any) {
      console.error(
        "Error getting appointment types:",
        error.response?.data || error.message,
      );
      throw new Error(
        `Practitioner Hub API error (get appointment types): ${
          error.response?.data?.message || error.message
        }`,
      );
    }
  }

  // Get Locations
  async getLocations(): Promise<LocationsOptionsResponse> {
    const locations = [
      { id: 1, name: "Utrecht" },
      { id: 2, name: "Arnhem" },
      { id: 3, name: "Amsterdam" },
      { id: 4, name: "The Hague" },
      { id: 5, name: "Rotterdam" },
      { id: 6, name: "Haarlem" },
      { id: 7, name: "Kleiweg" },
      { id: 8, name: "Amersfoort" },
    ];

    return { locations };
  }

  // Create appointment
  async createAppointment(
    payload: CreateAppointmentRequest,
  ): Promise<CreateAppointmentSuccessResponse> {
    try {
      const body = {
        ...payload,
        status: payload.status ?? "pending",
      };

      const response = await practitionerHubClient.post("/appointments", body);

      return response.data as CreateAppointmentSuccessResponse;
    } catch (error: any) {
      console.error(
        "Error creating appointment:",
        error.response?.data || error.message,
      );

      throw new Error(
        `Practitioner Hub API error (create appointment): ${
          error.response?.data?.message || error.message
        }`,
      );
    }
  }

  // Search patient by email
  async searchPatientByEmail(email: string): Promise<any> {
    try {
      console.log(`Searching patient by email: ${email}`);

      const response = await practitionerHubClient.get("/patients", {
        params: {
          email: `eq:${email}`,
        },
      });

      console.log(`Patient search result for email ${email}:`, response.data);

      return {
        data: response.data?.data || [],
        total: response.data?.total_entries || 0,
      };
    } catch (error: any) {
      console.error(
        "Error searching patient by email:",
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  // Create a new patient
  async createPatient(payload: {
    email: string;
    first_name?: string;
    last_name?: string;
  }): Promise<any> {
    try {
      console.log(`Creating new patient with email: ${payload.email}`);

      const response = await practitionerHubClient.post("/patients", {
        email: payload.email,
        first_name: payload.first_name || "New",
        last_name: payload.last_name || "Patient",
      });

      console.log(`Patient created successfully:`, response.data);
      // return response.data;
      return {
        id: response.data.id ?? response.data,
        email: payload.email,
        first_name: payload.first_name || "New",
        last_name: payload.last_name || "Patient",
      };
    } catch (error: any) {
      console.error(
        "Error creating patient:",
        error.response?.data || error.message,
      );
      throw new Error(
        `Failed to create patient: ${error.response?.data?.message || error.message}`,
      );
    }
  }
}

export const practitionerHubService = new PractitionerHubService();
