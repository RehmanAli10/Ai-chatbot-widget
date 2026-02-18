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

export class PractitionerHubService {
  // Search practitioners by first and last name
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

      return {
        practitioners,
      };
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

      let { start, end } = getDateRange(14, true);
      console.log(`Searching current week: ${start} to ${end}`);

      let response;

      if (practitionerId) {
        response = await practitionerHubClient.get("/timeslot_availability", {
          params: {
            location_id: locationId,
            appointment_type_id: appointmentTypeId,
            start,
            end,
            practitioner_id: practitionerId,
          },
        });
      } else {
        response = await practitionerHubClient.get("/timeslot_availability", {
          params: {
            location_id: locationId,
            appointment_type_id: appointmentTypeId,
            start,
            end,
          },
        });
      }

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
        name: "Utrecht",
      },
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
}

export const practitionerHubService = new PractitionerHubService();
