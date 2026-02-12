import { FastifyRequest, FastifyReply } from "fastify";
import { ChatRequest, ChatResponse } from "../types/chat.types.js";
import { openAIService } from "../services/openai.service.js";
import { conversationService } from "../services/conversation.service.js";

export class ChatController {
  async handleMessage(
    request: FastifyRequest<{ Body: ChatRequest }>,
    reply: FastifyReply,
  ): Promise<ChatResponse> {
    const { sessionId, message, patientId, bookingState, extra } = request.body;

    if (!sessionId || !message) {
      reply.code(400);
      throw new Error("sessionId and message are required");
    }

    try {
      console.log(`Processing message for session ${sessionId}`);
      console.log(`Message: "${message}"`);
      console.log(`Booking State:`, bookingState);
      console.log(`Extra Data:`, extra);

      // Check for connection or reset option using intent
      const correctionResult = await this.handleCorrectionIntent(
        sessionId,
        message,
        bookingState,
      );
      if (correctionResult) {
        return correctionResult;
      }

      // Add user message to conversation history
      conversationService.addMessage(sessionId, {
        role: "user",
        content: message,
      });

      // Get conversation history
      let messages = conversationService.getMessages(sessionId);

      // Build context message with booking state and session context
      const sessionContext = conversationService.getContext(sessionId);
      const contextMessage = this.buildContextMessage(
        bookingState,
        extra,
        sessionContext,
      );
      if (contextMessage) {
        console.log(`Context Message:\n${contextMessage}`);
        messages = [
          ...messages,
          {
            role: "system",
            content: contextMessage,
          },
        ];
      }

      // Get AI response with function calling
      const aiResponse = await openAIService.chat(messages);
      const aiMessage = aiResponse.message;

      // Check if AI wants to call a function
      if (aiMessage?.function_call) {
        const functionName = aiMessage.function_call.name;
        const functionArgs = aiMessage.function_call.arguments
          ? JSON.parse(aiMessage.function_call.arguments)
          : {};

        console.log(`Function Call: ${functionName}`, functionArgs);

        // Add function call to history
        conversationService.addMessage(sessionId, {
          role: "assistant",
          content: aiMessage.content || "",
          name: functionName,
        });

        // Execute the function
        const functionResult = await openAIService.executeFunction(
          functionName,
          functionArgs,
        );

        console.log(`Function Result:`, functionResult);

        // Store patientId in session context if patient was verified
        if (
          functionResult.type === "patient_verified" &&
          functionResult.patientId
        ) {
          conversationService.updateContext(sessionId, {
            patientId: functionResult.patientId,
            patient: functionResult.patient,
          });
          console.log(
            `Stored patient ID ${functionResult.patientId} in session context`,
          );
        }

        // Add function result to history
        conversationService.addMessage(sessionId, {
          role: "function",
          name: functionName,
          content: JSON.stringify(functionResult),
        });

        // Get updated conversation history
        messages = conversationService.getMessages(sessionId);

        // Add context again for final response
        const updatedSessionContext = conversationService.getContext(sessionId);
        const updatedContextMessage = this.buildContextMessage(
          bookingState,
          extra,
          updatedSessionContext,
        );
        if (updatedContextMessage) {
          messages = [
            ...messages,
            {
              role: "system",
              content: updatedContextMessage,
            },
          ];
        }

        // Get final AI response with function result
        const finalResponse = await openAIService.chat(messages);
        let finalMessage = finalResponse.message?.content || "";

        console.log(`AI Final Message: "${finalMessage}"`);

        // If AI didn't provide a good response, provide a fallback
        if (
          !finalMessage ||
          finalMessage.includes("I couldn't generate a response")
        ) {
          console.log("AI provided empty/bad response, using fallback");
          finalMessage = this.getFallbackMessage(functionResult);
          console.log(`Fallback Message: "${finalMessage}"`);
        }

        // Add final AI response to history
        conversationService.addMessage(sessionId, {
          role: "assistant",
          content: finalMessage,
        });

        // Check if we need to trigger next step automatically
        const nextStepResult = await this.checkAndTriggerNextStep(
          sessionId,
          functionResult,
          bookingState,
          message,
        );

        if (nextStepResult) {
          const mergedReply = {
            ...nextStepResult,
            aiMessage: finalMessage,
          };

          if (functionResult.patientId) {
            mergedReply.patientId = functionResult.patientId;
          }

          return {
            reply: mergedReply,
          };
        }

        // Return structured response with AI message
        return {
          reply: {
            ...functionResult,
            aiMessage: finalMessage,
          },
        };
      }

      // No function call regular text response
      const textMessage =
        aiMessage?.content || "I couldn't generate a response.";

      console.log(`AI Text Message: "${textMessage}"`);

      conversationService.addMessage(sessionId, {
        role: "assistant",
        content: textMessage,
      });

      const nextStepResult = await this.checkAndTriggerNextStep(
        sessionId,
        { type: "message", message: textMessage },
        bookingState,
        message,
      );

      if (nextStepResult) {
        console.log(`Auto-triggered next step:`, nextStepResult);
        return {
          reply: {
            ...nextStepResult,
            aiMessage: textMessage,
          },
        };
      }

      return {
        reply: {
          type: "message",
          message: textMessage,
        },
      };
    } catch (error: any) {
      console.error(`Chat Controller Error:`, error);
      request.log.error(error);
      reply.code(500);
      throw new Error(`Chat error: ${error.message}`);
    }
  }

  // Handle correction intents using AI to understand what user wants to correct
  private async handleCorrectionIntent(
    sessionId: string,
    message: string,
    bookingState: any,
  ): Promise<ChatResponse | null> {
    const lowerMessage = message.toLowerCase();

    // Detect correction keywords
    const correctionKeywords = [
      "wrong",
      "mistake",
      "incorrect",
      "change",
      "correct",
      "sorry",
      "actually",
      "oops",
      "no that's not",
      "not right",
      "that's wrong",
      "fix",
      "update",
      "different",
      "another",
      "start over",
      "restart",
      "begin again",
    ];

    const isCorrection = correctionKeywords.some((keyword) =>
      lowerMessage.includes(keyword),
    );

    if (!isCorrection) {
      return null;
    }

    console.log(`Detected correction intent: "${message}"`);

    // Understanding the intent
    const correctionIntent = await this.detectCorrectionIntent(
      sessionId,
      message,
      bookingState,
    );

    console.log(`Correction intent analysis:`, correctionIntent);

    // Handle based on detected intent
    switch (correctionIntent.action) {
      case "restart_all":
        return this.handleRestartAll(sessionId);

      case "correct_email":
        return this.handleCorrectEmail(sessionId);

      case "change_location":
        return this.handleChangeLocation(sessionId);

      case "change_appointment_type":
        return this.handleChangeAppointmentType(sessionId);

      case "change_time_slot":
        return this.handleChangeTimeSlot(sessionId, bookingState);

      case "unclear":
        return {
          reply: {
            type: "message",
            message:
              "I understand you'd like to make a change. Could you please specify what you'd like to correct?\n\n" +
              "You can say:\n" +
              "- 'I gave the wrong email'\n" +
              "- 'Change my location'\n" +
              "- 'Different appointment type'\n" +
              "- 'Start over completely'",
          },
        };

      default:
        return null;
    }
  }

  // What user wants to correct
  private async detectCorrectionIntent(
    sessionId: string,
    message: string,
    bookingState: any,
  ): Promise<{ action: string; confidence: number }> {
    const sessionContext = conversationService.getContext(sessionId);
    const hasPatientId = !!sessionContext?.patientId;
    const hasLocation = !!bookingState?.locationId;
    const hasAppointmentType = !!bookingState?.appointmentTypeId;
    const hasSlot = !!bookingState?.selectedSlot;

    // context for AI to understand
    const context = `
User message: "${message}"

Current booking state:
- Patient verified: ${hasPatientId ? "Yes" : "No"}
- Location selected: ${hasLocation ? "Yes" : "No"}
- Appointment type selected: ${hasAppointmentType ? "Yes" : "No"}
- Time slot selected: ${hasSlot ? "Yes" : "No"}

Analyze what the user wants to correct and return one of:
- "restart_all" - User wants to start completely from beginning
- "correct_email" - User wants to correct their email
- "change_location" - User wants to change location selection
- "change_appointment_type" - User wants to change appointment type
- "change_time_slot" - User wants to change time slot
- "unclear" - Not clear what user wants to correct
`;

    try {
      const response = await openAIService.analyzeCorrection(context, message);
      return response;
    } catch (error) {
      console.error("Error detecting correction intent:", error);
      return this.fallbackCorrectionDetection(
        message,
        bookingState,
        sessionContext,
      );
    }
  }

  // Fallback correction detection using keywords when AI fails
  private fallbackCorrectionDetection(
    message: string,
    bookingState: any,
    sessionContext: any,
  ): { action: string; confidence: number } {
    const lowerMessage = message.toLowerCase();

    // Check for complete restart
    if (
      lowerMessage.includes("start over") ||
      lowerMessage.includes("restart") ||
      lowerMessage.includes("begin again") ||
      lowerMessage.includes("all wrong") ||
      lowerMessage.includes("everything wrong") ||
      lowerMessage.includes("all info wrong") ||
      lowerMessage.includes("all information wrong")
    ) {
      return { action: "restart_all", confidence: 0.9 };
    }

    // Check for email correction
    if (lowerMessage.includes("email")) {
      return { action: "correct_email", confidence: 0.8 };
    }

    // Check for location change
    if (
      lowerMessage.includes("location") ||
      (bookingState?.locationId &&
        !bookingState?.appointmentTypeId &&
        !bookingState?.selectedSlot)
    ) {
      return { action: "change_location", confidence: 0.7 };
    }

    // Check for appointment type change
    if (
      lowerMessage.includes("appointment type") ||
      lowerMessage.includes("type of appointment") ||
      (lowerMessage.includes("type") &&
        bookingState?.appointmentTypeId &&
        !bookingState?.selectedSlot)
    ) {
      return { action: "change_appointment_type", confidence: 0.7 };
    }

    // Check for time slot change
    if (
      lowerMessage.includes("time") ||
      lowerMessage.includes("slot") ||
      lowerMessage.includes("schedule") ||
      bookingState?.selectedSlot
    ) {
      return { action: "change_time_slot", confidence: 0.7 };
    }

    return { action: "unclear", confidence: 0.5 };
  }

  // Handle complete restart
  private handleRestartAll(sessionId: string): ChatResponse {
    console.log("User wants to restart completely");

    conversationService.clearPatientSearchAttempts(sessionId);
    conversationService.updateContext(sessionId, {
      patientId: undefined,
      patient: undefined,
      locationId: undefined,
      appointmentTypeId: undefined,
      selectedSlot: undefined,
    });

    conversationService.clearSession(sessionId);

    return {
      reply: {
        type: "restart_booking",
        clearState: true,
        message:
          "No problem! Let's start fresh from the beginning. 😊\n\nPlease provide your first name and last name so I can verify your account.",
        aiMessage:
          "No problem! Let's start fresh from the beginning. 😊\n\nPlease provide your first name and last name so I can verify your account.",
      },
    };
  }

  private handleCorrectEmail(sessionId: string): ChatResponse {
    console.log("User wants to correct their email");

    conversationService.clearPatientSearchAttempts(sessionId);
    conversationService.updateContext(sessionId, {
      patientId: undefined,
      patient: undefined,
    });

    return {
      reply: {
        type: "clear_patient",
        message: "No problem! Please provide your correct email address.",
        aiMessage: "No problem! Please provide your correct email address.",
      },
    };
  }

  private async handleChangeLocation(sessionId: string): Promise<ChatResponse> {
    console.log("User wants to change location");

    conversationService.updateContext(sessionId, {
      locationId: undefined,
      appointmentTypeId: undefined,
      selectedSlot: undefined,
    });

    try {
      const locationsResult =
        await openAIService.executeFunction("get_locations");

      conversationService.addMessage(sessionId, {
        role: "function",
        name: "get_locations",
        content: JSON.stringify(locationsResult),
      });

      return {
        reply: {
          ...locationsResult,
          clearLocation: true,
          aiMessage:
            "Sure! Let me show you the available locations again. Please select one:",
        },
      };
    } catch (error) {
      console.error("Error fetching locations:", error);
      return {
        reply: {
          type: "error",
          message: "Sorry, I had trouble fetching locations. Please try again.",
        },
      };
    }
  }

  private async handleChangeAppointmentType(
    sessionId: string,
  ): Promise<ChatResponse> {
    console.log("User wants to change appointment type");

    conversationService.updateContext(sessionId, {
      appointmentTypeId: undefined,
      selectedSlot: undefined,
    });

    try {
      const appointmentTypesResult = await openAIService.executeFunction(
        "get_appointment_types",
      );

      conversationService.addMessage(sessionId, {
        role: "function",
        name: "get_appointment_types",
        content: JSON.stringify(appointmentTypesResult),
      });

      return {
        reply: {
          ...appointmentTypesResult,
          clearAppointmentType: true,
          aiMessage:
            "Sure! Let me show you the appointment types again. Please select one:",
        },
      };
    } catch (error) {
      console.error("Error fetching appointment types:", error);
      return {
        reply: {
          type: "error",
          message:
            "Sorry, I had trouble fetching appointment types. Please try again.",
        },
      };
    }
  }

  private async handleChangeTimeSlot(
    sessionId: string,
    bookingState: any,
  ): Promise<ChatResponse> {
    console.log("User wants to change time slot");

    conversationService.updateContext(sessionId, {
      selectedSlot: undefined,
    });

    if (!bookingState?.locationId || !bookingState?.appointmentTypeId) {
      return {
        reply: {
          type: "message",
          message:
            "To show you available time slots, I need to know your location and appointment type first. Let's start again with location selection.",
        },
      };
    }

    try {
      const slotsResult = await openAIService.executeFunction(
        "check_available_slots",
        {
          locationId: bookingState.locationId.toString(),
          appointmentTypeId: bookingState.appointmentTypeId,
        },
      );

      conversationService.addMessage(sessionId, {
        role: "function",
        name: "check_available_slots",
        content: JSON.stringify(slotsResult),
      });

      return {
        reply: {
          ...slotsResult,
          clearSlot: true,
          aiMessage:
            "Sure! Let me show you the available time slots again. Please select one:",
        },
      };
    } catch (error) {
      console.error("Error fetching slots:", error);
      return {
        reply: {
          type: "error",
          message:
            "Sorry, I had trouble fetching available slots. Please try again.",
        },
      };
    }
  }

  // Build context message to inform AI about current booking state
  private buildContextMessage(
    bookingState: any,
    extra: any,
    sessionContext?: any,
  ): string | null {
    if (!bookingState && !extra && !sessionContext) return null;

    const parts: string[] = ["CURRENT BOOKING STATE:"];
    let hasContent = false;

    const patientId = bookingState?.patientId || sessionContext?.patientId;

    // Check if patient ID exist
    if (!patientId) {
      parts.push(`- Patient ID: NOT VERIFIED`);
      parts.push(
        ` IMPORTANT: Patient verification is required before proceeding.`,
      );
      parts.push(
        `  Action: You MUST call search_patient(firstName, lastName) with the user's name.`,
      );
      hasContent = true;
    } else {
      parts.push(`- Patient ID: ${patientId} (verified)`);
      if (sessionContext?.patient) {
        parts.push(
          `  - Name: ${sessionContext.patient.first_name} ${sessionContext.patient.last_name}`,
        );
      }
      hasContent = true;
    }

    if (bookingState?.locationId) {
      parts.push(`- Location ID: ${bookingState.locationId} (selected)`);
      hasContent = true;
    }

    if (bookingState?.appointmentTypeId) {
      parts.push(
        `- Appointment Type ID: ${bookingState.appointmentTypeId} (selected)`,
      );
      hasContent = true;
    }

    if (bookingState?.selectedSlot) {
      parts.push(`- Selected Slot:`);
      parts.push(`  - Slot ID: ${bookingState.selectedSlot.id}`);
      parts.push(
        `  - Practitioner ID: ${bookingState.selectedSlot.practitionerId}`,
      );
      parts.push(`  - Start: ${bookingState.selectedSlot.start}`);
      parts.push(`  - End: ${bookingState.selectedSlot.end}`);
      if (bookingState.selectedSlot.practitionerName) {
        parts.push(
          `  - Practitioner: ${bookingState.selectedSlot.practitionerName}`,
        );
      }
      hasContent = true;
    }

    if (extra) {
      if (extra.practitionerId) {
        parts.push(
          `- Extra: Practitioner ID from selection: ${extra.practitionerId}`,
        );
        hasContent = true;
      }

      if (extra.start && extra.end) {
        parts.push(
          `- Extra: Time slot details: ${extra.start} to ${extra.end}`,
        );
        hasContent = true;
      }
    }

    if (!hasContent) return null;

    parts.push(
      "\nUse this state to determine the next step in the booking workflow.",
    );

    if (!patientId) {
      parts.push(
        "CRITICAL: Patient is NOT verified. You MUST verify the patient first before proceeding with any other steps.",
      );
    } else {
      parts.push(
        "If all required information is present, proceed with the appropriate function call automatically.",
      );
    }

    return parts.join("\n");
  }

  // Provide fallback messages when AI doesn't respond properly
  private getFallbackMessage(functionResult: any): string {
    switch (functionResult.type) {
      case "patient_verified":
        return `Great! I've verified your account, ${functionResult.patient?.first_name}. Let me show you our available locations.`;
      case "locations_list":
        return "Please select one of the locations above.";
      case "appointment_types_list":
        return "Please select the type of appointment you'd like to book.";
      case "available_slots":
        return functionResult.data?.length > 0
          ? "Please select one of the available time slots above."
          : "I couldn't find any available slots. Would you like to try a different date range?";
      case "appointment_confirmed":
        return "🎉 Your appointment has been successfully booked!";
      case "multiple_patients_found":
        return "I found multiple patients with that name. Could you please provide your email address?";
      case "email_not_found":
        return "I couldn't find a match with that email. Could you please provide your phone number?";
      case "patient_not_found":
        return "I couldn't find a patient record. Please contact our support team for assistance.";
      default:
        return "How can I help you further?";
    }
  }

  private async checkAndTriggerNextStep(
    sessionId: string,
    functionResult: any,
    bookingState: any,
    userMessage: string,
  ): Promise<any> {
    try {
      if (functionResult.type === "appointment_confirmed") {
        console.log("Appointment already confirmed, skipping auto-trigger");
        return null;
      }

      if (functionResult.type === "patient_verified") {
        console.log("Auto-triggering get_locations after patient verification");
        const locationsResult =
          await openAIService.executeFunction("get_locations");

        conversationService.addMessage(sessionId, {
          role: "function",
          name: "get_locations",
          content: JSON.stringify(locationsResult),
        });

        return locationsResult;
      }

      if (
        bookingState?.locationId &&
        !bookingState?.appointmentTypeId &&
        !bookingState?.selectedSlot
      ) {
        console.log(
          `Auto-triggering get_appointment_types (locationId: ${bookingState.locationId})`,
        );
        const appointmentTypesResult = await openAIService.executeFunction(
          "get_appointment_types",
        );

        conversationService.addMessage(sessionId, {
          role: "function",
          name: "get_appointment_types",
          content: JSON.stringify(appointmentTypesResult),
        });

        return appointmentTypesResult;
      }

      if (
        bookingState?.locationId &&
        bookingState?.appointmentTypeId &&
        !bookingState?.selectedSlot
      ) {
        console.log(`Auto-triggering check_available_slots`);
        const slotsResult = await openAIService.executeFunction(
          "check_available_slots",
          {
            locationId: bookingState.locationId.toString(),
            appointmentTypeId: bookingState.appointmentTypeId,
          },
        );

        conversationService.addMessage(sessionId, {
          role: "function",
          name: "check_available_slots",
          content: JSON.stringify(slotsResult),
        });

        return slotsResult;
      }

      if (
        bookingState?.locationId &&
        bookingState?.appointmentTypeId &&
        bookingState?.selectedSlot &&
        userMessage.includes("slot_")
      ) {
        console.log(`Auto-triggering create_appointment`);

        const sessionContext = conversationService.getContext(sessionId);
        const patientId = bookingState.patientId || sessionContext?.patientId;

        const appointmentResult = await openAIService.executeFunction(
          "create_appointment",
          {
            patientId: patientId,
            locationId: bookingState.locationId,
            appointmentTypeId: bookingState.appointmentTypeId,
            practitionerId: bookingState.selectedSlot.practitionerId,
            start: bookingState.selectedSlot.start,
            end: bookingState.selectedSlot.end,
          },
        );

        conversationService.addMessage(sessionId, {
          role: "function",
          name: "create_appointment",
          content: JSON.stringify(appointmentResult),
        });

        return appointmentResult;
      }

      return null;
    } catch (error) {
      console.error("Error in checkAndTriggerNextStep:", error);
      return null;
    }
  }

  async getHistory(
    request: FastifyRequest<{ Params: { sessionId: string } }>,
    reply: FastifyReply,
  ): Promise<any> {
    const { sessionId } = request.params;

    try {
      const session = conversationService.getSession(sessionId);

      if (!session) {
        reply.code(404);
        throw new Error("Session not found");
      }

      return {
        sessionId,
        messageCount: session.messages.length,
        messages: session.messages,
        context: session.context,
        lastUpdated: session.lastUpdated,
      };
    } catch (error: any) {
      request.log.error(error);
      reply.code(500);
      throw new Error(`Get history error: ${error.message}`);
    }
  }

  async clearSession(
    request: FastifyRequest<{ Params: { sessionId: string } }>,
    reply: FastifyReply,
  ): Promise<{ success: boolean; message: string }> {
    const { sessionId } = request.params;

    try {
      conversationService.clearSession(sessionId);

      return {
        success: true,
        message: `Session ${sessionId} cleared successfully`,
      };
    } catch (error: any) {
      request.log.error(error);
      reply.code(500);
      throw new Error(`Clear session error: ${error.message}`);
    }
  }

  async getAllSessions(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<any> {
    try {
      const sessionIds = conversationService.getAllSessionIds();
      const sessionCount = conversationService.getActiveSessionCount();

      return {
        totalSessions: sessionCount,
        sessions: sessionIds,
      };
    } catch (error: any) {
      request.log.error(error);
      reply.code(500);
      throw new Error(`Get sessions error: ${error.message}`);
    }
  }
}

export const chatController = new ChatController();
