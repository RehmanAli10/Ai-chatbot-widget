export interface LocationOption {
  id: number;
  name: string;
}

export interface LocationsOptionsResponse {
  locations: LocationOption[];
}

export interface AppointmentType {
  id: number;
  type: string;
}

export interface AppointmentTypesResponse {
  appointmentTypes: AppointmentType[];
}

export interface TimeSlot {
  id: number;
  start: string;
  end: string;
  title: string;
  practitionerId: number;
  practitionerName: string;
}

export interface TimeSlotAvailabilityResponse {
  availableTimeSlots: TimeSlot[];
  unavailableDates: string[];
}

export type AppointmentStatus =
  | "arrived"
  | "cancelled"
  | "missed"
  | "pending"
  | "processed";

export interface CreateAppointmentRequest {
  appointment_type_id: number;
  location_id: number;
  patient_id: number;
  practitioner_id: number;
  start: string;
  end: string;
  status?: AppointmentStatus;
}

export interface CreateAppointmentSuccessResponse {
  id: number;
}

export interface Patient {
  id: number;
  first_name?: string;
  last_name?: string;
  email?: string;
}

export interface VerifyPatientResponse {
  patient: Patient;
}
