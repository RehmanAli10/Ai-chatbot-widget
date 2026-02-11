import { practitionerHubClient } from "../config/practitioner-hub.config";
import {
  AppointmentTypesResponse,
  TimeSlotAvailabilityResponse,
  TimeSlot,
  LocationsOptionsResponse,
  CreateAppointmentSuccessResponse,
  CreateAppointmentRequest,
} from "../types/practitioner-hub.types.ts";
import { getDateRange } from "../utils/helpers.js";

export class PractitionerHubService {
  // Get available slots for appointment types
  async getAvailableSlots(
    locationId: string,
    appointmentTypeId: number,
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

      let { start, end } = getDateRange(7);
      console.log(`Searching current week: ${start} to ${end}`);

      let response = await practitionerHubClient.get("/timeslot_availability", {
        params: {
          location_id: locationId,
          appointment_type_id: appointmentTypeId,
          start,
          end,
        },
      });

      let availableTimeSlots: TimeSlot[] = (response.data?.available ?? []).map(
        (slot: any) => ({
          id: slot.id,
          start: slot.start,
          end: slot.end,
          title: slot.title,
          practitionerId: slot.practitioner_id,
          practitionerName: slot.practitioner_name,
        }),
      );

      const unavailableDates: string[] = response.data?.unavailable ?? [];

      console.log(`Found ${availableTimeSlots.length} slots in current week`);

      if (availableTimeSlots.length === 0) {
        console.log(
          `No slots found in current week, extending search to 14 days`,
        );

        ({ start, end } = getDateRange(14));
        console.log(`Extended search: ${start} to ${end}`);

        response = await practitionerHubClient.get("/timeslot_availability", {
          params: {
            location_id: locationId,
            appointment_type_id: appointmentTypeId,
            start,
            end,
          },
        });

        availableTimeSlots = (response.data?.available ?? []).map(
          (slot: any) => ({
            id: slot.id,
            start: slot.start,
            end: slot.end,
            title: slot.title,
            practitionerId: slot.practitioner_id,
            practitionerName: slot.practitioner_name,
          }),
        );

        console.log(
          `Found ${availableTimeSlots.length} slots in extended search (14 days)`,
        );
      }

      return {
        availableTimeSlots,
        unavailableDates,
      };
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
      {
        id: 1,
        name: "One Chiropractic Studio (Utrecht, Bemuurde Weerd Oostzijde 67)",
      },
      { id: 2, name: "One Chiropractic Studio (Arnhem, Rijnstraat 57)" },
      { id: 3, name: "One Chiropractic Studio (Amsterdam, Aalsmeerweg 94-96)" },
      { id: 4, name: "One Chiropractic Studio (The Hague, Nobelstraat 25-29)" },
      { id: 5, name: "One Chiropractic Studio (Rotterdam, Schiekade 129)" },
      { id: 6, name: "One Chiropractic Studio (Haarlem, Gierstraat 53)" },
      { id: 7, name: "One Chiropractic Studio (Kleiweg 54, Gouda)" },
      { id: 8, name: "One Chiropractic Studio (Amersfoort, Kamp 76)" },
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
}

export const practitionerHubService = new PractitionerHubService();
