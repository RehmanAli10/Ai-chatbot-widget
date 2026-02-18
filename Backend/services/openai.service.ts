import { openai, OPENAI_CONFIG } from "../config/openai.config.js";
import { ChatMessage } from "../types/chat.types.js";
import { APPOINTMENT_BOOKING_SYSTEM_PROMPT } from "../prompts/system-prompts.js";
import { practitionerHubService } from "./practitioner-hub.service.js";

export type IntentAction =
  | "booking"
  | "restart_all"
  | "correct_email"
  | "change_practitioner"
  | "change_location"
  | "change_appointment_type"
  | "change_time_slot"
  | "correction_unclear"
  | "booking_for_other" // User wants to book for child / family member
  | "unsupported_date_request" // User asks for today / specific date
  | "cancel_reschedule" // User wants to cancel or reschedule
  | "none";

export interface IntentResult {
  action: IntentAction;
  confidence: number;
  isCorrectionIntent: boolean;
}

export class OpenAIService {
  private readonly functions = [
    {
      name: "search_practitioners",
      description:
        "Search practitioners by first and last name. CRITICAL: Call this function IMMEDIATELY whenever a user mentions a doctor's name (e.g., 'Dr. Smith', 'doctor John', 'with Francesco Ferrero', 'I want to see Sarah Johnson'). This is your highest priority action. Do NOT wait to verify patient first - practitioner selection can happen before patient verification. The system will remember the selected practitioner.",
      parameters: {
        type: "object",
        properties: {
          firstName: { type: "string", description: "First name" },
          lastName: { type: "string", description: "Last name" },
        },
        required: ["firstName", "lastName"],
      },
    },
    {
      name: "search_patient_by_email",
      description:
        "Search for a patient by email address. CRITICAL: If the message also contains a practitioner name (e.g. 'Dr. John Smith'), do NOT call this function yet - call search_practitioners first instead. Only call this when: (1) the message has ONLY an email with no practitioner name, or (2) the practitioner has already been verified in a previous turn.",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "Patient email address" },
        },
        required: ["email"],
      },
    },
    {
      name: "get_locations",
      description: "Get available clinic locations.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_appointment_types",
      description: "Get available appointment types.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      name: "check_available_slots",
      description:
        "Get available time slots for given location and appointment type.",
      parameters: {
        type: "object",
        properties: {
          locationId: { type: "string", description: "Location ID" },
          appointmentTypeId: {
            type: "number",
            description: "Appointment type ID",
          },
          practitionerId: {
            type: "number",
            description: "Optional: filter to a specific practitioner",
          },
        },
        required: ["locationId", "appointmentTypeId"],
      },
    },
    {
      name: "create_appointment",
      description: "Create an appointment booking.",
      parameters: {
        type: "object",
        properties: {
          patientId: { type: "number" },
          locationId: { type: "number" },
          appointmentTypeId: { type: "number" },
          practitionerId: { type: "number" },
          start: { type: "string", description: "YYYY-MM-DD HH:MM:SS" },
          end: { type: "string", description: "YYYY-MM-DD HH:MM:SS" },
        },
        required: [
          "patientId",
          "locationId",
          "appointmentTypeId",
          "practitionerId",
          "start",
          "end",
        ],
      },
    },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // extractPractitionerName
  // Extract doctor/practitioner name from user message
  // ─────────────────────────────────────────────────────────────────────────
  async extractPractitionerName(
    message: string,
  ): Promise<{ firstName: string; lastName: string } | null> {
    const prompt = `
Extract the doctor/practitioner name from this message. 
Return ONLY the first and last name in JSON format, or null if no clear doctor name is mentioned.

Examples:
- "I want to book with Dr. John Smith" → {"firstName":"John","lastName":"Smith"}
- "appointment with doctor Francesco Ferrero" → {"firstName":"Francesco","lastName":"Ferrero"}
- "see Dr. Sarah Johnson" → {"firstName":"Sarah","lastName":"Johnson"}
- "book with Smith" → null (need full name)
- "any doctor is fine" → null
- "I'd like to see Maria Garcia" → {"firstName":"Maria","lastName":"Garcia"}
- "appointment with Dr. Chen" → null (need full name)

Message: "${message}"

Return ONLY valid JSON. No markdown. No explanation.
`;

    try {
      const response = await openai.chat.completions.create({
        model: OPENAI_CONFIG.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 60,
      });

      const raw = response.choices[0].message?.content ?? "null";
      const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
      return JSON.parse(cleaned);
    } catch (err) {
      console.error("[extractPractitionerName] error:", err);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // messageContainsPractitionerName
  // Quick check if message might contain a practitioner name
  // ─────────────────────────────────────────────────────────────────────────
  messageContainsPractitionerName(message: string): boolean {
    const lower = message.toLowerCase();

    // Check for explicit doctor indicators
    if (
      lower.includes("dr.") ||
      lower.includes("doctor") ||
      lower.includes("dr ")
    ) {
      return true;
    }

    // Check for name patterns (two capitalized words in a row)
    // This helps catch names without titles like "I want to see Sarah Johnson"
    if (/[A-Z][a-z]+ [A-Z][a-z]+/.test(message)) {
      // Make sure it's in a booking context
      return (
        lower.includes("book") ||
        lower.includes("appointment") ||
        lower.includes("see") ||
        lower.includes("with") ||
        lower.includes("doctor")
      );
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // analyzeIntent
  // Called ONLY for free-text messages. System selections (numeric, slot_*,
  // practitioner_*) are intercepted by the controller before reaching here.
  // ─────────────────────────────────────────────────────────────────────────
  async analyzeIntent(
    userMessage: string,
    bookingState: any,
    sessionContext: any,
  ): Promise<IntentResult> {
    // Hard guard — system selections should never reach this, but be safe
    if (
      /^slot_\d+$/.test(userMessage) ||
      /^practitioner_\d+$/.test(userMessage) ||
      /^\d+$/.test(userMessage)
    ) {
      return { action: "booking", confidence: 1.0, isCorrectionIntent: false };
    }

    // First, check if this message contains a practitioner name (even without explicit doctor title)
    if (
      !bookingState?.practitionerId &&
      this.messageContainsPractitionerName(userMessage)
    ) {
      // Quick check - if it has a name pattern and booking-related words, it's likely a booking intent
      const lower = userMessage.toLowerCase();
      if (
        lower.includes("book") ||
        lower.includes("appointment") ||
        lower.includes("see") ||
        lower.includes("with")
      ) {
        return {
          action: "booking",
          confidence: 0.95,
          isCorrectionIntent: false,
        };
      }
    }

    const state = {
      patientVerified: !!bookingState?.patientId,
      practitionerSelected: !!bookingState?.practitionerId,
      locationSelected: !!bookingState?.locationId,
      appointmentTypeSelected: !!bookingState?.appointmentTypeId,
      slotSelected: !!bookingState?.selectedSlot,
    };

    const prompt = `
You are an intent classifier for an appointment booking chatbot.
The message below is FREE TEXT typed by a real user (not a system button click).

Current booking progress:
- Patient verified: ${state.patientVerified}
- Practitioner selected: ${state.practitionerSelected}
- Location selected: ${state.locationSelected}
- Appointment type selected: ${state.appointmentTypeSelected}
- Time slot selected: ${state.slotSelected}

User message: "${userMessage}"

Choose the SINGLE best action:

  "booking"                 → Normal booking progress (name, email, "yes", "book appointment")
  "booking_for_other"       → User wants to book for their child, spouse, or someone else
  "restart_all"             → User wants to start completely over
  "correct_email"           → User wants to fix/change their email address
  "change_practitioner"     → User wants a different practitioner
  "change_location"         → User wants a different location
  "change_appointment_type" → User wants a different appointment type
  "change_time_slot"        → User wants a different time slot
  "correction_unclear"      → User clearly wants to change something but it is ambiguous what
  "unsupported_date_request"→ User is asking to book for a specific date/time (e.g. "today", "tomorrow morning", "next Monday")
  "cancel_reschedule"       → User wants to cancel or reschedule an existing appointment
  "none"                    → General chit-chat or question unrelated to booking flow

Classification rules:
  - Prefer "booking" for normal forward progress.
  - Use correction actions ONLY when clearly changing something already confirmed.
  - "isCorrectionIntent" must be true for any correction_*, restart_all, and booking_for_other (since it interrupts the current booking).
  - "confidence" is 0.0–1.0.

Return ONLY valid JSON. No markdown fences. No explanation.
Example: {"action":"change_appointment_type","confidence":0.95,"isCorrectionIntent":true}
`.trim();

    try {
      const response = await openai.chat.completions.create({
        model: OPENAI_CONFIG.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 80,
      });

      const raw = response.choices[0].message?.content ?? "{}";
      const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
      const result = JSON.parse(cleaned) as IntentResult;
      console.log("[analyzeIntent]", { message: userMessage, result });
      return result;
    } catch (err) {
      console.error("[analyzeIntent] error, defaulting to 'none':", err);
      return { action: "none", confidence: 0, isCorrectionIntent: false };
    }
  }

  async chat(messages: ChatMessage[]): Promise<any> {
    try {
      const response = await openai.chat.completions.create({
        model: OPENAI_CONFIG.model,
        messages: [
          { role: "system", content: APPOINTMENT_BOOKING_SYSTEM_PROMPT },
          ...messages,
        ],
        functions: this.functions,
        function_call: "auto",
        temperature: OPENAI_CONFIG.temperature,
        max_tokens: OPENAI_CONFIG.maxTokens,
      });
      return response.choices[0];
    } catch (error: any) {
      console.error("OpenAI chat error:", error);
      throw new Error(`OpenAI API error: ${error.message}`);
    }
  }

  async executeFunction(functionName: string, args?: any): Promise<any> {
    console.log(`[executeFunction] ${functionName}`, args);
    try {
      switch (functionName) {
        case "search_practitioners": {
          if (!args?.firstName || !args?.lastName) {
            return {
              type: "error",
              message: "First and last name are required.",
            };
          }
          const result = await practitionerHubService.searchPractitioners(
            args.firstName,
            args.lastName,
          );
          if (result.practitioners.length === 0) {
            return {
              type: "practitioner_not_found",
              message: `No practitioner found named ${args.firstName} ${args.lastName}. Please check the spelling or try a different name.`,
            };
          }
          if (result.practitioners.length === 1) {
            const p = result.practitioners[0];
            return {
              type: "practitioner_verified",
              practitionerId: p.id,
              practitioner: p,
              message: `Found: ${p.name}`,
            };
          }
          return {
            type: "practitioners_list",
            data: result.practitioners,
            count: result.practitioners.length,
            message: `Found ${result.practitioners.length} practitioners. Please select one.`,
          };
        }

        case "search_patient_by_email": {
          if (!args?.email) {
            return { type: "error", message: "Email address is required." };
          }
          const result = await practitionerHubService.searchPatientByEmail(
            args.email,
          );
          if (result.total === 0) {
            return {
              type: "patient_not_found",
              message: "patient_not_found",
            };
          }
          const patient = result.data[0];
          return {
            type: "patient_verified",
            patientId: patient.id,
            patient,
            message: `Verified: ${patient.first_name} ${patient.last_name}`,
          };
        }

        case "get_locations": {
          const res = await practitionerHubService.getLocations();
          return {
            type: "locations_list",
            data: res.locations,
            message: "Please select a location:",
          };
        }

        case "get_appointment_types": {
          const res = await practitionerHubService.getAppointmentTypes();
          return {
            type: "appointment_types_list",
            data: res.appointmentTypes,
            message: "Please select an appointment type:",
          };
        }

        case "check_available_slots": {
          if (!args?.locationId || !args?.appointmentTypeId) {
            return {
              type: "error",
              message: "Location and appointment type are required.",
            };
          }
          const res = await practitionerHubService.getAvailableSlots(
            args.locationId,
            args.appointmentTypeId,
            args.practitionerId,
          );
          return {
            type: "available_slots",
            data: res.availableTimeSlots,
            unavailableDates: res.unavailableDates,
            message:
              res.availableTimeSlots.length > 0
                ? "Available slots found."
                : "No slots found.",
          };
        }

        case "create_appointment": {
          const required = [
            "patientId",
            "locationId",
            "appointmentTypeId",
            "practitionerId",
            "start",
            "end",
          ];
          const missing = required.filter(
            (f) => args?.[f] === undefined || args?.[f] === null,
          );
          if (missing.length > 0) {
            return {
              type: "error",
              message: `Missing required fields: ${missing.join(", ")}`,
            };
          }
          const payload = {
            appointment_type_id: args.appointmentTypeId,
            location_id: args.locationId,
            patient_id: args.patientId,
            practitioner_id: args.practitionerId,
            start: args.start,
            end: args.end,
            status: "pending",
          };
          const created =
            await practitionerHubService.createAppointment(payload);
          return {
            type: "appointment_confirmed",
            data: created,
            message: `🎉 Appointment booked!\n\nID: ${created.id}\nDate & Time: ${payload.start}`,
          };
        }

        default:
          return {
            type: "error",
            message: `Unknown function: ${functionName}`,
          };
      }
    } catch (error: any) {
      console.error(`[executeFunction] ${functionName} error:`, error);
      return {
        type: "error",
        message: `Failed to run ${functionName}: ${error.message}`,
      };
    }
  }

  async generateResponse(messages: ChatMessage[]): Promise<any> {
    const choice = await this.chat(messages);
    const message = choice.message;
    if (message?.function_call) {
      const { name, arguments: rawArgs } = message.function_call;
      return await this.executeFunction(
        name,
        rawArgs ? JSON.parse(rawArgs) : {},
      );
    }
    return { type: "message", message: message?.content || "How can I help?" };
  }
}

export const openAIService = new OpenAIService();
