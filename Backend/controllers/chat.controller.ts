import { FastifyRequest, FastifyReply } from "fastify";
import { ChatRequest, ChatResponse } from "../types/chat.types.js";
import { openAIService } from "../services/openai.service.js";
import { conversationService } from "../services/conversation.service.js";

export class ChatController {
  async handleMessage(
    request: FastifyRequest<{ Body: ChatRequest }>,
    reply: FastifyReply,
  ): Promise<ChatResponse> {
    const { sessionId, message, bookingState, extra } = request.body;

    if (!sessionId || !message) {
      reply.code(400);
      throw new Error("sessionId and message are required");
    }

    try {
      console.log(`\n[${sessionId}] ── Incoming ──`);
      console.log(`  message: "${message}"`);
      console.log(`  bookingState:`, JSON.stringify(bookingState));

      const sessionContext = conversationService.getContext(sessionId);

      const mergedState = this.mergeBookingState(bookingState, sessionContext);
      console.log(`  mergedState:`, JSON.stringify(mergedState));

      if (this.isSystemSelection(message)) {
        console.log(`  [system-selection]`);
        return await this.handleSystemSelection(
          sessionId,
          message,
          mergedState,
          extra,
          sessionContext,
        );
      }

      // NEW: Check for practitioner name in message FIRST
      // Only search if practitioner not already selected and message likely contains a name
      if (
        !mergedState.practitionerId &&
        openAIService.messageContainsPractitionerName(message)
      ) {
        console.log(`  [checking for practitioner name]`);
        const practitionerName =
          await openAIService.extractPractitionerName(message);

        if (practitionerName?.firstName && practitionerName?.lastName) {
          console.log(`  [practitioner name extracted]:`, practitionerName);

          // Call search_practitioners immediately
          const result = await openAIService.executeFunction(
            "search_practitioners",
            {
              firstName: practitionerName.firstName,
              lastName: practitionerName.lastName,
            },
          );

          // Add the function result to conversation
          conversationService.addMessage(sessionId, {
            role: "function",
            name: "search_practitioners",
            content: JSON.stringify(result),
          });

          // Handle the result based on type
          if (result.type === "practitioner_verified") {
            conversationService.updateContext(sessionId, {
              practitionerId: result.practitionerId,
              practitioner: result.practitioner,
            });

            // Get fresh context after update
            const updatedContext = conversationService.getContext(sessionId);
            const updatedMerged = this.mergeBookingState(
              bookingState,
              updatedContext,
            );

            // Check if message also contains an email
            const emailMatch = message.match(
              /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
            );

            if (emailMatch) {
              // Message contains both practitioner name AND email - handle email next
              console.log(`  [email also found in message]`);
              const emailResult = await openAIService.executeFunction(
                "search_patient_by_email",
                {
                  email: emailMatch[0],
                },
              );

              conversationService.addMessage(sessionId, {
                role: "function",
                name: "search_patient_by_email",
                content: JSON.stringify(emailResult),
              });

              if (emailResult.type === "patient_verified") {
                conversationService.updateContext(sessionId, {
                  patientId: emailResult.patientId,
                  patient: emailResult.patient,
                });

                // Both practitioner and patient verified - auto-trigger locations
                const locationsResult = await this.autoTrigger(
                  sessionId,
                  "get_locations",
                );
                return {
                  reply: {
                    ...locationsResult,
                    aiMessage: `Great! I've selected Dr. ${result.practitioner.name} and verified your account. Now please select a location from the options above.`,
                  },
                };
              } else {
                // Patient not found with that email
                return {
                  reply: {
                    ...emailResult,
                    aiMessage: `I've selected Dr. ${result.practitioner.name}, but ${emailResult.message || "I couldn't verify your email."} Please provide a valid email address.`,
                  },
                };
              }
            }

            // No email in message, just practitioner verified
            if (updatedMerged.patientId) {
              // Patient already verified from previous session
              const locationsResult = await this.autoTrigger(
                sessionId,
                "get_locations",
              );
              return {
                reply: {
                  ...locationsResult,
                  aiMessage: `Great! I've selected Dr. ${result.practitioner.name}. Now please select a location from the options above.`,
                },
              };
            }

            // Patient not verified yet
            return {
              reply: {
                type: "message",
                aiMessage: `I've found Dr. ${result.practitioner.name}. Now please provide your email address to verify your account.`,
              },
            };
          } else if (result.type === "practitioners_list") {
            return {
              reply: {
                ...result,
                aiMessage: `I found multiple practitioners with that name. Please select one from the options above.`,
              },
            };
          } else {
            // practitioner_not_found
            return {
              reply: {
                ...result,
                aiMessage: result.message,
              },
            };
          }
        }
      }

      // Continue with normal intent analysis
      const intent = await openAIService.analyzeIntent(
        message,
        mergedState,
        sessionContext,
      );
      console.log(`  intent:`, intent);

      if (intent.action === "unsupported_date_request") {
        return this.handleUnsupportedDateRequest(
          sessionId,
          message,
          mergedState,
        );
      }

      if (intent.action === "cancel_reschedule") {
        return this.handleCancelReschedule(sessionId);
      }

      if (intent.action === "booking_for_other") {
        return this.handleBookingForOther(sessionId, mergedState);
      }

      if (intent.isCorrectionIntent) {
        const correctionReply = await this.handleCorrectionByIntent(
          sessionId,
          message,
          intent.action,
          mergedState,
        );
        if (correctionReply) return correctionReply;
      }

      return await this.runAIConversation(
        sessionId,
        message,
        mergedState,
        extra,
        sessionContext,
      );
    } catch (error: any) {
      console.error(`[${sessionId}] Controller error:`, error);
      request.log.error(error);
      reply.code(500);
      throw new Error(`Chat error: ${error.message}`);
    }
  }

  private mergeBookingState(bookingState: any, sessionContext: any): any {
    return {
      patientId: sessionContext?.patientId ?? bookingState?.patientId ?? null,
      practitionerId:
        sessionContext?.practitionerId ?? bookingState?.practitionerId ?? null,
      locationId: bookingState?.locationId ?? null,
      appointmentTypeId: bookingState?.appointmentTypeId ?? null,
      selectedSlot: bookingState?.selectedSlot ?? null,
    };
  }

  private isSystemSelection(message: string): boolean {
    return (
      /^slot_\d+$/.test(message) ||
      /^practitioner_\d+$/.test(message) ||
      /^\d+$/.test(message)
    );
  }

  private async handleSystemSelection(
    sessionId: string,
    message: string,
    mergedState: any,
    extra: any,
    sessionContext: any,
  ): Promise<ChatResponse> {
    conversationService.addMessage(sessionId, {
      role: "user",
      content: message,
    });

    if (message.startsWith("slot_") && mergedState.selectedSlot) {
      if (!mergedState.patientId) {
        return {
          reply: {
            type: "message",
            aiMessage:
              "I need to verify your identity first. Please provide your email address.",
          },
        };
      }
      const result = await this.autoTrigger(sessionId, "create_appointment", {
        patientId: mergedState.patientId,
        locationId: mergedState.locationId,
        appointmentTypeId: mergedState.appointmentTypeId,
        practitionerId: mergedState.selectedSlot.practitionerId,
        start: mergedState.selectedSlot.start,
        end: mergedState.selectedSlot.end,
      });
      const aiMsg =
        result.type === "appointment_confirmed"
          ? `🎉 Your appointment has been booked successfully!\n\n${result.message}\n\nIs there anything else I can help you with? If you'd like to book another appointment, just let me know!`
          : this.getFallbackMessage(result);
      return { reply: { ...result, aiMessage: aiMsg } };
    }

    if (message.startsWith("practitioner_")) {
      const practId = parseInt(message.replace("practitioner_", ""), 10);
      conversationService.updateContext(sessionId, { practitionerId: practId });
      if (mergedState.patientId) {
        const result = await this.autoTrigger(sessionId, "get_locations");
        return {
          reply: {
            ...result,
            aiMessage:
              "Great choice! Please select a location from the options above.",
          },
        };
      }
      return {
        reply: {
          type: "message",
          aiMessage:
            "Great! Now please provide your email address so I can verify your patient account.",
        },
      };
    }

    if (mergedState.locationId && !mergedState.appointmentTypeId) {
      const result = await this.autoTrigger(sessionId, "get_appointment_types");
      return {
        reply: {
          ...result,
          aiMessage:
            "Please choose an appointment type from the options above.",
        },
      };
    }

    if (
      mergedState.locationId &&
      mergedState.appointmentTypeId &&
      !mergedState.selectedSlot
    ) {
      const result = await this.autoTrigger(
        sessionId,
        "check_available_slots",
        {
          locationId: mergedState.locationId.toString(),
          appointmentTypeId: mergedState.appointmentTypeId,
          practitionerId: sessionContext?.practitionerId ?? undefined,
        },
      );
      const aiMsg =
        result.data?.length > 0
          ? "Here are the available time slots — please pick one:"
          : "No slots are available for the selected criteria. Would you like to try a different location or appointment type?";
      return { reply: { ...result, aiMessage: aiMsg } };
    }

    return await this.runAIConversation(
      sessionId,
      message,
      mergedState,
      extra,
      sessionContext,
    );
  }

  private handleUnsupportedDateRequest(
    sessionId: string,
    message: string,
    mergedState: any,
  ): ChatResponse {
    conversationService.addMessage(sessionId, {
      role: "user",
      content: message,
    });
    const aiMessage =
      "I'm not able to filter by a specific date, but I can show you all available slots " +
      "for the next 14 days — the earliest ones will appear first. 📅\n\n" +
      "If you need same-day assistance, please call the clinic directly and they'll do " +
      "their best to accommodate you.\n\n" +
      "Would you like me to continue and show you what's available online?";

    conversationService.addMessage(sessionId, {
      role: "assistant",
      content: aiMessage,
    });
    return { reply: { type: "message", aiMessage } };
  }

  private handleCancelReschedule(sessionId: string): ChatResponse {
    const aiMessage =
      "I can only help with new bookings right now. 😊\n\n" +
      "To cancel or reschedule an existing appointment, please contact the clinic directly " +
      "or use the patient portal. Would you like to book a new appointment instead?";
    conversationService.addMessage(sessionId, {
      role: "assistant",
      content: aiMessage,
    });
    return { reply: { type: "message", aiMessage } };
  }

  private handleBookingForOther(
    sessionId: string,
    mergedState: any,
  ): ChatResponse {
    // Clear patient verification so we collect the other person's email
    conversationService.updateContext(sessionId, {
      patientId: undefined,
      patient: undefined,
    });

    const aiMessage =
      "Of course! Every patient needs their own registered account. 😊\n\n" +
      "Please provide their email address and I'll look up their patient record.";

    conversationService.addMessage(sessionId, {
      role: "assistant",
      content: aiMessage,
    });
    return {
      reply: {
        type: "clear_patient",
        aiMessage,
      },
    };
  }

  private async handleCorrectionByIntent(
    sessionId: string,
    message: string,
    action: string,
    mergedState: any,
  ): Promise<ChatResponse | null> {
    console.log(`[${sessionId}] Correction: ${action}`);

    switch (action) {
      case "restart_all": {
        conversationService.clearSession(sessionId);
        return {
          reply: {
            type: "restart_booking",
            clearState: true,
            aiMessage:
              "No problem! Let's start fresh. 😊\n\nWould you like to book with a specific practitioner, or see all available appointments?",
          },
        };
      }

      case "correct_email": {
        conversationService.updateContext(sessionId, {
          patientId: undefined,
          patient: undefined,
        });

        if (message.includes("@")) return null;
        return {
          reply: {
            type: "clear_patient",
            aiMessage:
              "No problem! Please provide your correct email address and I'll verify your account.",
          },
        };
      }

      case "change_practitioner": {
        conversationService.updateContext(sessionId, {
          practitionerId: undefined,
          practitioner: undefined,
        });
        // If a Proper Name is already in the message, let AI call search_practitioners
        if (/[A-Z][a-z]+ [A-Z][a-z]+/.test(message)) return null;
        return {
          reply: {
            type: "clear_practitioner",
            clearPractitioner: true,
            aiMessage:
              "Of course! Who would you like to book with? Please provide their first and last name.",
          },
        };
      }

      case "change_location": {
        conversationService.updateContext(sessionId, {
          locationId: undefined,
          appointmentTypeId: undefined,
          selectedSlot: undefined,
        });
        const locResult = await this.autoTrigger(sessionId, "get_locations");
        return {
          reply: {
            ...locResult,
            clearLocation: true,
            aiMessage:
              "Sure! Here are the available locations — please select one:",
          },
        };
      }

      case "change_appointment_type": {
        if (!mergedState.locationId) {
          const locResult = await this.autoTrigger(sessionId, "get_locations");
          return {
            reply: {
              ...locResult,
              clearLocation: true,
              aiMessage:
                "Let's start from location — please select one and then I'll show you the appointment types:",
            },
          };
        }
        conversationService.updateContext(sessionId, {
          appointmentTypeId: undefined,
          selectedSlot: undefined,
        });
        const typesResult = await this.autoTrigger(
          sessionId,
          "get_appointment_types",
        );
        return {
          reply: {
            ...typesResult,
            clearAppointmentType: true,
            aiMessage:
              "No problem! Here are the appointment types again — please pick one:",
          },
        };
      }

      case "change_time_slot": {
        if (!mergedState.locationId) {
          const locResult = await this.autoTrigger(sessionId, "get_locations");
          return {
            reply: {
              ...locResult,
              clearLocation: true,
              aiMessage: "Let's go back to location first — please select one:",
            },
          };
        }
        if (!mergedState.appointmentTypeId) {
          const typesResult = await this.autoTrigger(
            sessionId,
            "get_appointment_types",
          );
          return {
            reply: {
              ...typesResult,
              clearAppointmentType: true,
              aiMessage:
                "Please choose an appointment type first, then I'll show you the available slots:",
            },
          };
        }
        conversationService.updateContext(sessionId, {
          selectedSlot: undefined,
        });
        const slotsResult = await this.autoTrigger(
          sessionId,
          "check_available_slots",
          {
            locationId: mergedState.locationId.toString(),
            appointmentTypeId: mergedState.appointmentTypeId,
            practitionerId: mergedState.practitionerId ?? undefined,
          },
        );
        return {
          reply: {
            ...slotsResult,
            clearSlot: true,
            aiMessage:
              "Of course! Here are the available slots again — please pick one:",
          },
        };
      }

      case "correction_unclear": {
        return {
          reply: {
            type: "message",
            aiMessage:
              "I'd be happy to help! What would you like to change — your email, practitioner, location, appointment type, or time slot?",
          },
        };
      }

      default:
        return null;
    }
  }

  private async runAIConversation(
    sessionId: string,
    message: string,
    mergedState: any,
    extra: any,
    sessionContext: any,
  ): Promise<ChatResponse> {
    conversationService.addMessage(sessionId, {
      role: "user",
      content: message,
    });

    let messages = conversationService.getMessages(sessionId);
    const contextMsg = this.buildContextMessage(mergedState, extra);
    if (contextMsg) {
      messages = [...messages, { role: "system", content: contextMsg }];
    }

    const aiResponse = await openAIService.chat(messages);
    const aiMessage = aiResponse.message;

    if (aiMessage?.function_call) {
      const { name: fnName, arguments: rawArgs } = aiMessage.function_call;
      const fnArgs = rawArgs ? JSON.parse(rawArgs) : {};
      console.log(`[${sessionId}] Function call: ${fnName}`, fnArgs);

      conversationService.addMessage(sessionId, {
        role: "assistant",
        content: aiMessage.content || "",
        name: fnName,
      });

      const fnResult = await openAIService.executeFunction(fnName, fnArgs);
      console.log(`[${sessionId}] Result: ${fnResult.type}`);

      if (fnResult.type === "patient_verified" && fnResult.patientId) {
        conversationService.updateContext(sessionId, {
          patientId: fnResult.patientId,
          patient: fnResult.patient,
        });
      }
      if (
        fnResult.type === "practitioner_verified" &&
        fnResult.practitionerId
      ) {
        conversationService.updateContext(sessionId, {
          practitionerId: fnResult.practitionerId,
          practitioner: fnResult.practitioner,
        });
      }

      conversationService.addMessage(sessionId, {
        role: "function",
        name: fnName,
        content: JSON.stringify(fnResult),
      });

      const updatedCtx = conversationService.getContext(sessionId);
      const updatedMerged = this.mergeBookingState(mergedState, updatedCtx);

      let updatedMessages = conversationService.getMessages(sessionId);
      const updatedCtxMsg = this.buildContextMessage(updatedMerged, extra);
      if (updatedCtxMsg) {
        updatedMessages = [
          ...updatedMessages,
          { role: "system", content: updatedCtxMsg },
        ];
      }

      const followUp = await openAIService.chat(updatedMessages);
      let finalMessage = followUp.message?.content || "";
      if (!finalMessage || finalMessage.includes("I couldn't generate")) {
        finalMessage = this.getFallbackMessage(fnResult);
      }

      conversationService.addMessage(sessionId, {
        role: "assistant",
        content: finalMessage,
      });

      const autoResult = await this.checkAndTriggerNextStep(
        sessionId,
        fnResult,
      );
      if (autoResult) {
        return {
          reply: {
            ...autoResult,
            aiMessage: finalMessage,
            ...(fnResult.patientId && { patientId: fnResult.patientId }),
            ...(fnResult.practitionerId && {
              practitionerId: fnResult.practitionerId,
            }),
          },
        };
      }

      return {
        reply: {
          ...fnResult,
          aiMessage: finalMessage,
          ...(fnResult.patientId && { patientId: fnResult.patientId }),
          ...(fnResult.practitionerId && {
            practitionerId: fnResult.practitionerId,
          }),
        },
      };
    }

    const textMessage = aiMessage?.content || "How can I help you?";
    conversationService.addMessage(sessionId, {
      role: "assistant",
      content: textMessage,
    });
    return { reply: { type: "message", aiMessage: textMessage } };
  }

  private async checkAndTriggerNextStep(
    sessionId: string,
    fnResult: any,
  ): Promise<any> {
    try {
      if (fnResult.type === "appointment_confirmed") return null;

      const freshCtx = conversationService.getContext(sessionId);

      if (fnResult.type === "practitioner_verified") {
        if (freshCtx?.patientId) {
          console.log(
            `[auto-trigger] get_locations (patient already verified server-side)`,
          );
          return await this.autoTrigger(sessionId, "get_locations");
        }
        return null;
      }

      if (fnResult.type === "patient_verified") {
        console.log(`[auto-trigger] get_locations after patient_verified`);
        return await this.autoTrigger(sessionId, "get_locations");
      }

      return null;
    } catch (err) {
      console.error("[checkAndTriggerNextStep] error:", err);
      return null;
    }
  }

  private async autoTrigger(
    sessionId: string,
    fnName: string,
    args?: any,
  ): Promise<any> {
    const result = await openAIService.executeFunction(fnName, args);
    conversationService.addMessage(sessionId, {
      role: "function",
      name: fnName,
      content: JSON.stringify(result),
    });
    return result;
  }

  private buildContextMessage(mergedState: any, extra?: any): string | null {
    const parts: string[] = ["CURRENT BOOKING STATE:"];

    if (mergedState.practitionerId) {
      parts.push(`- Practitioner ID: ${mergedState.practitionerId} (selected)`);
    } else {
      parts.push(`- Practitioner: NOT SELECTED`);
    }

    if (!mergedState.patientId) {
      parts.push(`- Patient: NOT VERIFIED`);
      parts.push(
        `  ⚠ Must call search_patient_by_email(email) before any other step.`,
      );
    } else {
      parts.push(`- Patient ID: ${mergedState.patientId} (verified)`);
    }

    parts.push(`- Location ID: ${mergedState.locationId ?? "not selected"}`);
    parts.push(
      `- Appointment Type ID: ${mergedState.appointmentTypeId ?? "not selected"}`,
    );

    if (mergedState.selectedSlot) {
      const s = mergedState.selectedSlot;
      parts.push(
        `- Slot: ${s.start} → ${s.end} (Practitioner: ${s.practitionerId})`,
      );
    }

    if (extra?.start && extra?.end) {
      parts.push(`- Extra slot: ${extra.start} → ${extra.end}`);
    }

    parts.push("");

    if (!mergedState.patientId) {
      parts.push(
        "NEXT: Patient unverified. Ask for email → call search_patient_by_email.",
      );
    } else if (!mergedState.locationId) {
      parts.push(
        "NEXT: Show locations (system will auto-trigger get_locations).",
      );
    } else if (!mergedState.appointmentTypeId) {
      parts.push(
        "NEXT: Show appointment types (system will auto-trigger get_appointment_types).",
      );
    } else if (!mergedState.selectedSlot) {
      parts.push(
        "NEXT: Show available slots (system will auto-trigger check_available_slots).",
      );
    } else {
      parts.push(
        "NEXT: Create the appointment (system will auto-trigger create_appointment).",
      );
    }

    if (mergedState.practitionerId && mergedState.appointmentTypeId) {
      parts.push(
        `NOTE: Filter slots by practitionerId = ${mergedState.practitionerId}.`,
      );
    }

    return parts.join("\n");
  }

  private getFallbackMessage(fnResult: any): string {
    switch (fnResult.type) {
      case "practitioner_verified":
        return `Great! I found ${fnResult.practitioner?.name}. Please provide your email address to verify your account.`;
      case "practitioner_not_found":
        return "I couldn't find that practitioner. Please check the spelling, or let me know if you'd like to see all available appointments.";
      case "patient_verified":
        return `Verified! Welcome, ${fnResult.patient?.first_name}. Please select a location from the options above.`;
      case "patient_not_found":
        return "I couldn't find an account with that email. Please double-check the spelling and try again, or contact our support team if you haven't registered yet.";
      case "locations_list":
        return "Please select a location from the options above.";
      case "appointment_types_list":
        return "Please select an appointment type from the options above.";
      case "available_slots":
        return fnResult.data?.length > 0
          ? "Please select a time slot from the options above."
          : "No slots available. Would you like to try a different location or appointment type?";
      case "appointment_confirmed":
        return "🎉 Your appointment has been booked successfully! Is there anything else I can help you with?";
      default:
        return "How can I help you next?";
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
      return { success: true, message: `Session ${sessionId} cleared` };
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
      return {
        totalSessions: conversationService.getActiveSessionCount(),
        sessions: conversationService.getAllSessionIds(),
      };
    } catch (error: any) {
      request.log.error(error);
      reply.code(500);
      throw new Error(`Get sessions error: ${error.message}`);
    }
  }
}

export const chatController = new ChatController();
