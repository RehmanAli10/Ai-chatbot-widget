import { openai, OPENAI_CONFIG } from "../config/openai.config.js";
import { ChatMessage } from "../types/chat.types.js";
import { APPOINTMENT_BOOKING_SYSTEM_PROMPT } from "../prompts/system-prompts.js";
import { practitionerHubService } from "./practitioner-hub.service.js";

export class OpenAIService {
  private readonly functions = [
    {
      name: "search_patient_by_email",
      description:
        "Search for a patient by email address (fallback when multiple name matches)",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description: "Patient's email address",
          },
        },
        required: ["email"],
      },
    },
    {
      name: "get_locations",
      description:
        "Get list of available clinic locations. Call this IMMEDIATELY after successful patient verification.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_appointment_types",
      description:
        "Get list of available appointment types (ONE Adjustment or Initial Assessment). Call this IMMEDIATELY after user selects a location.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "check_available_slots",
      description:
        "Check available appointment time slots. Call this IMMEDIATELY after user selects an appointment type.",
      parameters: {
        type: "object",
        properties: {
          locationId: {
            type: "string",
            description: "Location ID (convert to string if needed)",
          },
          appointmentTypeId: {
            type: "number",
            description:
              "Appointment type ID (1 for ONE Adjustment, 2 for Initial Assessment)",
          },
        },
        required: ["locationId", "appointmentTypeId"],
      },
    },
    {
      name: "create_appointment",
      description:
        "Create appointment booking. Call this IMMEDIATELY after user selects a time slot. All required info should be available in the conversation context.",
      parameters: {
        type: "object",
        properties: {
          patientId: {
            type: "number",
            description: "Patient ID from verified patient",
          },
          locationId: {
            type: "number",
            description: "Location ID from user selection",
          },
          appointmentTypeId: {
            type: "number",
            description: "Appointment type ID from user selection",
          },
          practitionerId: {
            type: "number",
            description: "Practitioner ID from the selected time slot",
          },
          start: {
            type: "string",
            description:
              "Start time from selected slot (YYYY-MM-DD HH:MM:SS format)",
          },
          end: {
            type: "string",
            description:
              "End time from selected slot (YYYY-MM-DD HH:MM:SS format)",
          },
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

  // Analyzing user correction intent using AI
  async analyzeCorrection(
    context: string,
    userMessage: string,
  ): Promise<{ action: string; confidence: number }> {
    try {
      const response = await openai.chat.completions.create({
        model: OPENAI_CONFIG.model,
        messages: [
          {
            role: "system",
            content: `You are a correction intent analyzer. Analyze user messages to determine what they want to correct in their appointment booking.

Return ONLY a JSON object with this structure:
{
  "action": "one of: restart_all, correct_name, correct_email, correct_phone, change_location, change_appointment_type, change_time_slot, unclear",
  "confidence": 0.0-1.0
}

Action definitions:
- restart_all: User wants to start completely from beginning (keywords: "all wrong", "everything wrong", "start over", "restart", "begin again", "all info wrong")
- correct_name: User wants to correct their name (keywords: "wrong name", "incorrect name", "first name", "last name")
- correct_email: User wants to correct email (keywords: "email", "wrong email")
- correct_phone: User wants to correct phone (keywords: "phone", "wrong phone")
- change_location: User wants to change location (keywords: "location", "different location", "change location")
- change_appointment_type: User wants to change appointment type (keywords: "appointment type", "different type", "change type")
- change_time_slot: User wants to change time slot (keywords: "time", "slot", "schedule", "different time")
- unclear: Not clear what to correct

Examples:
"sorry i have provided all info wrong" -> {"action": "restart_all", "confidence": 0.95}
"i gave wrong first name and last name" -> {"action": "correct_name", "confidence": 0.9}
"sorry i have provided wrong info" (when at location selection) -> {"action": "change_location", "confidence": 0.7}
"actually i meant a different location" -> {"action": "change_location", "confidence": 0.9}
"can i change that?" -> {"action": "unclear", "confidence": 0.5}`,
          },
          {
            role: "user",
            content: context,
          },
        ],
        temperature: 0.3,
        max_tokens: 100,
      });

      const content = response.choices[0].message?.content || "{}";

      const cleanedContent = content.replace(/```json\n?|\n?```/g, "").trim();

      const result = JSON.parse(cleanedContent);
      console.log(`AI correction analysis:`, result);

      return result;
    } catch (error) {
      console.error("Error in analyzeCorrection:", error);
      return { action: "unclear", confidence: 0 };
    }
  }

  // Chat with OpenAI with full conversation history
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
      console.error("OpenAI API Error:", error);
      throw new Error(`OpenAI API error: ${error.message}`);
    }
  }

  // returns structured result
  async executeFunction(functionName: string, args?: any): Promise<any> {
    console.log(`Executing function: ${functionName}`, args);

    try {
      switch (functionName) {
        case "search_patient_by_email": {
          if (!args?.email) {
            return {
              type: "error",
              message: "Email address is required.",
            };
          }

          console.log(`Searching patient by email: ${args.email}`);

          const result = await practitionerHubService.searchPatientByEmail(
            args.email,
          );

          if (result.total === 0) {
            return {
              type: "patient_not_found",
              message:
                "No patient found with that email address. Please contact our support team for assistance.",
            };
          } else {
            const patient = result.data[0];
            return {
              type: "patient_verified",
              patientId: patient.id,
              patient: patient,
              message: `Patient verified: ${patient.first_name} ${patient.last_name}`,
            };
          }
        }

        case "get_locations":
          const locationsResult = await practitionerHubService.getLocations();
          return {
            type: "locations_list",
            data: locationsResult.locations,
            message: "Please select a location:",
          };

        case "get_appointment_types":
          const appointmentTypesResult =
            await practitionerHubService.getAppointmentTypes();
          return {
            type: "appointment_types_list",
            data: appointmentTypesResult.appointmentTypes,
            message: "Please select an appointment type:",
          };

        case "check_available_slots":
          if (!args?.locationId || !args?.appointmentTypeId) {
            return {
              type: "error",
              message:
                "Missing required information. Please provide location and appointment type.",
            };
          }

          const slotsResult = await practitionerHubService.getAvailableSlots(
            args.locationId,
            args.appointmentTypeId,
          );

          return {
            type: "available_slots",
            data: slotsResult.availableTimeSlots,
            unavailableDates: slotsResult.unavailableDates,
            message:
              slotsResult.availableTimeSlots.length > 0
                ? "Here are the available time slots:"
                : "Sorry, no available slots found. Would you like to try different dates?",
          };

        case "create_appointment": {
          console.log("Creating appointment with args:", args);

          const required = [
            "patientId",
            "locationId",
            "appointmentTypeId",
            "practitionerId",
            "start",
            "end",
          ];

          const missing = required.filter(
            (field) => args?.[field] === undefined || args?.[field] === null,
          );

          if (missing.length > 0) {
            return {
              type: "error",
              message: `Missing required fields: ${missing.join(", ")}. Please ensure all information is collected before booking.`,
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

          console.log("Sending appointment payload:", payload);

          const created =
            await practitionerHubService.createAppointment(payload);

          return {
            type: "appointment_confirmed",
            data: created,
            message: `🎉 Appointment booked successfully!\n\nAppointment ID: ${created.id}\nPatient ID: ${payload.patient_id}\nLocation: ${payload.location_id}\nDate & Time: ${payload.start}\nPractitioner ID: ${payload.practitioner_id}`,
          };
        }

        default:
          return {
            type: "error",
            message: "Unknown function called",
          };
      }
    } catch (error: any) {
      console.error(`Error executing function ${functionName}:`, error);
      return {
        type: "error",
        message: `Failed to execute ${functionName}: ${error.message}`,
      };
    }
  }

  // response with function calling support
  async generateResponse(messages: ChatMessage[]): Promise<any> {
    try {
      const choice = await this.chat(messages);
      const message = choice.message;

      if (message?.function_call) {
        const { name, arguments: args } = message.function_call;
        const parsedArgs = args ? JSON.parse(args) : {};
        return await this.executeFunction(name, parsedArgs);
      }

      const textMessage = message?.content || "I couldn't generate a response.";
      return {
        type: "message",
        message: textMessage,
      };
    } catch (error: any) {
      console.error("Error in generateResponse:", error);
      throw error;
    }
  }
}

export const openAIService = new OpenAIService();
