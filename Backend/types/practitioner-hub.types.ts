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
  status: string;
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

export interface Practitioner {
  id: number;
  first_name: string;
  last_name: string;
  active: string;
  columns: string;
  color: string;
  modality_id: string;
  online_booking: string;
  messenger_uid: string | null;
  slot_duration: string;
  description: string;
  default_clinical_note_type: string;
  photo: string[];
  updated: string;
  created: string;
}

export interface PractitionersResponse {
  total_entries: number;
  data: Practitioner[];
  links: {
    previous: string | null;
    self: string;
    next: string | null;
  };
}

export interface PractitionerSearchResult {
  practitioners: Array<{
    id: number;
    name: string;
    firstName: string;
    lastName: string;
  }>;
}
