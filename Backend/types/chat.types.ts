export type ChatMessage =
  | {
      role: "system";
      content: string;
    }
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      name?: string;
    }
  | {
      role: "function";
      name: string;
      content: string;
    };

export interface BookingState {
  patientId?: number | null;
  practitionerId?: number | null;
  locationId?: number | null;
  appointmentTypeId?: number | null;
  selectedSlot?: {
    id: number;
    start: string;
    end: string;
    practitionerId: number;
    practitionerName?: string;
  } | null;
}

export interface ExtraData {
  practitionerId?: number;
  start?: string;
  end?: string;
  [key: string]: any;
}

export interface ChatRequest {
  sessionId: string;
  message: string;
  patientId?: number;
  bookingState?: BookingState;
  mode?: "general" | "booking";
  extra?: ExtraData;
}

export interface ChatResponse {
  reply: ChatReply;
}

export interface ChatReply {
  type:
    | "message"
    | "practitioner_verified"
    | "practitioner_not_found"
    | "practitioners_list"
    | "patient_verified"
    | "patient_not_found"
    | "multiple_patients_found"
    | "email_not_found"
    | "locations_list"
    // | "appointment_types_list"
    | "available_slots"
    | "appointment_confirmed"
    | "restart_booking"
    | "clear_patient"
    | "clear_practitioner"
    | "error";
  message?: string;
  aiMessage?: string;
  data?: any;
  unavailableDates?: string[];
  patientId?: number;
  patient?: any;
  practitionerId?: number;
  practitioner?: any;
  count?: number;
  clearState?: boolean;
  clearPractitioner?: boolean;
  clearLocation?: boolean;
  clearAppointmentType?: boolean;
  clearSlot?: boolean;
  appointmentTypeId?: number;
}

export interface AppointmentData {
  patientId?: number;
  practitionerId?: number;
  isNewPatient?: boolean;
  locationId?: string | number;
  locationName?: string;
  appointmentTypeId?: number;
  appointmentTypeName?: string;
  selectedSlot?: {
    id: number;
    start: string;
    end: string;
    practitionerId: number;
    practitionerName?: string;
  };
  patientInfo?: {
    id?: number;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
  practitionerInfo?: {
    id?: number;
    firstName?: string;
    lastName?: string;
    name?: string;
  };
  patient?: any;
  practitioner?: any;
}

export interface SessionMetadata {
  patientSearchAttempts?: number;
  lastPatientSearchData?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  } | null;
  lastPractitionerSearchData?: {
    firstName?: string;
    lastName?: string;
  } | null;
  correctionCount?: number;
  lastCorrectionType?: string;
  lastCorrectionTimestamp?: Date;
}

export interface ConversationHistory {
  sessionId: string;
  messages: ChatMessage[];
  context?: AppointmentData;
  metadata?: SessionMetadata;
  lastUpdated: Date;
}

export interface CorrectionIntent {
  action:
    | "restart_all"
    | "correct_name"
    | "correct_email"
    | "correct_phone"
    | "change_practitioner"
    | "change_location"
    | "change_appointment_type"
    | "change_time_slot"
    | "unclear";
  confidence: number;
  detectedKeywords?: string[];
}

export interface PractitionerVerifiedResponse extends ChatReply {
  type: "practitioner_verified";
  practitionerId: number;
  practitioner: {
    id: number;
    name: string;
    firstName: string;
    lastName: string;
  };
}

export interface PractitionerNotFoundResponse extends ChatReply {
  type: "practitioner_not_found";
  message: string;
}

export interface PractitionersListResponse extends ChatReply {
  type: "practitioners_list";
  data: Array<{
    id: number;
    name: string;
    firstName: string;
    lastName: string;
  }>;
  count: number;
}

export interface PatientVerifiedResponse extends ChatReply {
  type: "patient_verified";
  patientId: number;
  patient: {
    id: number;
    first_name: string;
    last_name: string;
    email?: string;
    phone?: string;
  };
}

export interface PatientNotFoundResponse extends ChatReply {
  type: "patient_not_found";
  message: string;
}

export interface MultiplePatientsFounds extends ChatReply {
  type: "multiple_patients_found";
  count: number;
  message: string;
}

export interface EmailNotFoundResponse extends ChatReply {
  type: "email_not_found";
  message: string;
}

export interface LocationsListResponse extends ChatReply {
  type: "locations_list";
  data: Array<{
    id: number;
    name: string;
  }>;
  clearLocation?: boolean;
}

// export interface AppointmentTypesListResponse extends ChatReply {
//   type: "appointment_types_list";
//   data: Array<{
//     id: number;
//     type: string;
//   }>;
//   clearAppointmentType?: boolean;
// }

export interface AvailableSlotsResponse extends ChatReply {
  type: "available_slots";
  data: Array<{
    id: number;
    start: string;
    end: string;
    title: string;
    practitionerId: number;
    practitionerName: string;
  }>;
  unavailableDates?: string[];
  clearSlot?: boolean;
  appointmentTypeId?: number; // newly added
}

export interface AppointmentConfirmedResponse extends ChatReply {
  type: "appointment_confirmed";
  data: {
    id: number;
    patient_id: number;
    location_id: number;
    appointment_type_id: number;
    practitioner_id: number;
    start: string;
    end: string;
    status: string;
  };
}

export interface ErrorResponse extends ChatReply {
  type: "error";
  message: string;
}

export interface MessageResponse extends ChatReply {
  type: "message";
  message: string;
}

export interface RestartBookingResponse extends ChatReply {
  type: "restart_booking";
  clearState: true;
  message: string;
  aiMessage?: string;
}

export interface ClearPatientResponse extends ChatReply {
  type: "clear_patient";
  message: string;
  aiMessage?: string;
}

export interface ClearPractitionerResponse extends ChatReply {
  type: "clear_practitioner";
  clearPractitioner: true;
  message: string;
  aiMessage?: string;
}

export type AllChatReplies =
  | PractitionerVerifiedResponse
  | PractitionerNotFoundResponse
  | PractitionersListResponse
  | PatientVerifiedResponse
  | PatientNotFoundResponse
  | MultiplePatientsFounds
  | EmailNotFoundResponse
  | LocationsListResponse
  // | AppointmentTypesListResponse
  | AvailableSlotsResponse
  | AppointmentConfirmedResponse
  | RestartBookingResponse
  | ClearPatientResponse
  | ClearPractitionerResponse
  | ErrorResponse
  | MessageResponse;
