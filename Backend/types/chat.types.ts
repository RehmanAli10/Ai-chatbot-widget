export interface ChatMessage {
  role: "system" | "user" | "assistant" | "function";
  content: string;
  name?: string;
}

export interface BookingState {
  patientId?: number | null;
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
  [key: string]: any; // Allow additional fields
}

export interface ChatRequest {
  sessionId: string;
  message: string;
  patientId?: number; // Optional patient ID from frontend
  bookingState?: BookingState; // Current booking state
  extra?: ExtraData; // Extra data like slot details
}

export interface ChatResponse {
  reply: ChatReply;
}

export interface ChatReply {
  type:
    | "message"
    | "patient_verified"
    | "patient_not_found"
    | "multiple_patients_found"
    | "email_not_found"
    | "locations_list"
    | "appointment_types_list"
    | "available_slots"
    | "appointment_confirmed"
    | "restart_booking" // ✅ For complete restart
    | "clear_patient" // ✅ For clearing patient data only
    | "error";
  message?: string;
  aiMessage?: string; // AI-generated natural language response
  data?: any; // Structured data (locations, slots, etc.)
  unavailableDates?: string[]; // For available_slots response
  patientId?: number; // Include patient ID in responses
  patient?: any; // Full patient object
  count?: number; // For multiple_patients_found

  // ✅ State clearing flags
  clearState?: boolean; // Clear all booking state
  clearLocation?: boolean; // Clear location and subsequent selections
  clearAppointmentType?: boolean; // Clear appointment type and slot
  clearSlot?: boolean; // Clear time slot only
}

export interface AppointmentData {
  patientId?: number;
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
  patient?: any; // Full patient object from API
}

export interface SessionMetadata {
  patientSearchAttempts?: number;
  lastPatientSearchData?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  } | null;
  correctionCount?: number;
  lastCorrectionType?: string;
  lastCorrectionTimestamp?: Date; // ✅ Track when last correction was made
}

export interface ConversationHistory {
  sessionId: string;
  messages: ChatMessage[];
  context?: AppointmentData;
  metadata?: SessionMetadata;
  lastUpdated: Date;
}

// ✅ Correction Intent Analysis
export interface CorrectionIntent {
  action:
    | "restart_all"
    | "correct_name"
    | "correct_email"
    | "correct_phone"
    | "change_location"
    | "change_appointment_type"
    | "change_time_slot"
    | "unclear";
  confidence: number;
  detectedKeywords?: string[]; // Optional: keywords that triggered the detection
}

// Response types for different stages
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

// ✅ New response type for patient not found
export interface PatientNotFoundResponse extends ChatReply {
  type: "patient_not_found";
  message: string;
}

// ✅ New response type for multiple patients
export interface MultiplePatientsFounds extends ChatReply {
  type: "multiple_patients_found";
  count: number;
  message: string;
}

// ✅ New response type for email not found
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
  clearLocation?: boolean; // ✅ Optional flag for location change
}

export interface AppointmentTypesListResponse extends ChatReply {
  type: "appointment_types_list";
  data: Array<{
    id: number;
    type: string;
  }>;
  clearAppointmentType?: boolean; // ✅ Optional flag for appointment type change
}

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
  clearSlot?: boolean; // ✅ Optional flag for slot change
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

// ✅ New response types for corrections
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

// ✅ Union type for all possible chat replies
export type AllChatReplies =
  | PatientVerifiedResponse
  | PatientNotFoundResponse
  | MultiplePatientsFounds
  | EmailNotFoundResponse
  | LocationsListResponse
  | AppointmentTypesListResponse
  | AvailableSlotsResponse
  | AppointmentConfirmedResponse
  | RestartBookingResponse
  | ClearPatientResponse
  | ErrorResponse
  | MessageResponse;
