import { FastifyRequest, FastifyReply } from "fastify";
import { ChatRequest, ChatResponse } from "../types/chat.types.js";
import { openAIService } from "../services/openai.service.js";
import { conversationService } from "../services/conversation.service.js";

export class ChatController {
  // ═══════════════════════════════════════════════════════════════════════════
  // PRIMARY ENTRY POINT
  // ═══════════════════════════════════════════════════════════════════════════
  async handleMessage(
    request: FastifyRequest<{ Body: ChatRequest }>,
    reply: FastifyReply,
  ): Promise<ChatResponse> {
    const { sessionId, message, bookingState, mode, extra } = request.body;
    const isGeneralChat = mode === "general";

    if (!sessionId || !message) {
      reply.code(400);
      throw new Error("sessionId and message are required");
    }

    try {
      console.log(`\n[${sessionId}] ── Incoming ──`);
      console.log(`  message: "${message}"`);
      console.log(`  bookingState:`, JSON.stringify(bookingState));

      const sessionContext = conversationService.getContext(sessionId);

      // ── Merge frontend state with authoritative session context ────────────
      // Frontend sends stale state because it updates IDs locally AFTER the
      // API call. We always merge so the backend has the correct truth.
      const mergedState = this.mergeBookingState(bookingState, sessionContext);
      console.log(`  mergedState:`, JSON.stringify(mergedState));

      // ── General chat: bypass all booking logic, go straight to AI ──────────
      if (isGeneralChat) {
        return await this.runAIConversation(
          sessionId,
          message,
          mergedState,
          extra,
          sessionContext,
          true, // isGeneralChat flag
        );
      }

      // ── System selections bypass all intent analysis ───────────────────────
      // Button clicks (numeric IDs, slot_*, practitioner_*) are deterministic —
      // we know exactly what to do without asking the AI.
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

      // ── Welcome screen button handlers ─────────────────────────────────────
      // Special messages from frontend welcome screen buttons
      if (message === "__SCHEDULE_APPOINTMENT__") {
        console.log(`  [welcome-button] schedule appointment`);
        return await this.handleScheduleAppointment(sessionId);
      }

      if (message === "__INFO_REQUEST__") {
        console.log(`  [welcome-button] info request`);
        return await this.handleInfoRequest(sessionId);
      }

      if (message === "__GET_LOCATIONS__") {
        console.log(`  [get-locations] fetching locations`);
        const result = await this.autoTrigger(sessionId, "get_locations");
        return { reply: result };
      }

      // ── Email verification step from inline form ───────────────────────────────
      // Frontend sends "verify_email:<email>" to verify the patient during the form
      // step, before the full booking message is assembled.
      if (message.startsWith("verify_email:")) {
        const email = message.replace("verify_email:", "").trim();
        const firstName = request.body.extra?.firstName;
        const lastName = request.body.extra?.lastName;
        const patientResult = await openAIService.executeFunction(
          "search_patient_by_email",
          { email, firstName, lastName },
        );
        if (
          patientResult.type === "patient_verified" &&
          patientResult.patientId
        ) {
          conversationService.updateContext(sessionId, {
            patientId: patientResult.patientId,
            patient: patientResult.patient,
            isNewPatient: false,
          });
          // const firstName = patientResult.patient?.first_name || "there";
          return {
            reply: {
              ...patientResult,
              // aiMessage: `Welcome back, ${firstName}! `,
            },
          };
        }
        // Not found → treat as new patient
        conversationService.updateContext(sessionId, { isNewPatient: true });
        return {
          reply: {
            type: "patient_not_found",
          },
        };
      }

      // ── AI intent analysis — free text only ────────────────────────────────
      const intent = await openAIService.analyzeIntent(
        message,
        mergedState,
        sessionContext,
      );
      console.log(`  intent:`, intent);

      // ── CRITICAL: Practitioner name detection takes absolute precedence ────
      // If practitioner not yet selected AND message contains a name pattern,
      // force practitioner search path. This is deterministic and overrides AI.
      if (
        !mergedState.practitionerId &&
        this.containsPractitionerName(message)
      ) {
        console.log(
          `  [practitioner-name-detected] bypassing AI, forcing practitioner search`,
        );
        return await this.handlePractitionerNameInMessage(
          sessionId,
          message,
          mergedState,
          extra,
          sessionContext,
        );
      }

      // ── Route special intents deterministically ────────────────────────────
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
        // null means "fall through to AI" (e.g. new email/name is in the message)
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

  // ═══════════════════════════════════════════════════════════════════════════
  // MERGE BOOKING STATE
  //
  // SECURITY / CORRECTNESS RULES:
  //   patientId      → ONLY from sessionContext (server-verified). Never trust
  //                    the frontend value — it can be stale from a prior session.
  //   practitionerId → ONLY from sessionContext (server-verified after search).
  //   locationId     → frontend only (backend doesn't persist this).
  //   appointmentTypeId → frontend only.
  //   selectedSlot   → frontend only.
  // ═══════════════════════════════════════════════════════════════════════════
  private mergeBookingState(bookingState: any, sessionContext: any): any {
    return {
      patientId: sessionContext?.patientId ?? null, // server-only
      practitionerId: sessionContext?.practitionerId ?? null, // server-only
      locationId: bookingState?.locationId ?? null,
      appointmentTypeId: bookingState?.appointmentTypeId ?? null,
      selectedSlot: bookingState?.selectedSlot ?? null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SYSTEM SELECTION DETECTION
  // ═══════════════════════════════════════════════════════════════════════════
  private isSystemSelection(message: string): boolean {
    return (
      /^slot_\d+$/.test(message) ||
      /^practitioner_\d+$/.test(message) ||
      /^\d+$/.test(message)
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRACTITIONER NAME DETECTION — deterministic, overrides AI
  // Patterns: "doctor X Y", "Dr. X Y", "X Y" (two capitalized words)
  // ═══════════════════════════════════════════════════════════════════════════
  private containsPractitionerName(message: string): boolean {
    // Skip if user is introducing themselves
    if (/\bmy name is\b/i.test(message)) return false;

    // "doctor Firstname Lastname" or "Dr. Firstname Lastname"
    if (/\b(?:doctor|dr\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i.test(message))
      return true;

    // Two capitalized words only if NOT preceded by "name is/was/:" patterns
    if (/\b[A-Z][a-z]+\s+[A-Z][a-z]+/.test(message)) return true;

    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLE PRACTITIONER NAME IN MESSAGE
  // Deterministic routing when a practitioner name is detected.
  // Directly calls search_practitioners, then checks for email in the same message.
  // If both are present, verifies both before proceeding.
  // ═══════════════════════════════════════════════════════════════════════════
  private async handlePractitionerNameInMessage(
    sessionId: string,
    message: string,
    mergedState: any,
    extra: any,
    sessionContext: any,
  ): Promise<ChatResponse> {
    // Extract name — use non-greedy pattern that stops at "and" or email
    const nameMatch =
      message.match(/\b(?:doctor|dr\.?)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i) ||
      // Only match "with Name" or "see Name" — NOT "my name is Name"
      message.match(/\b(?:with|see|book)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/);
    if (!nameMatch) {
      return await this.runAIConversation(
        sessionId,
        message,
        mergedState,
        extra,
        sessionContext,
      );
    }

    const fullName = nameMatch[1].trim();
    const nameParts = fullName.split(/\s+/);

    if (nameParts.length < 2) {
      conversationService.addMessage(sessionId, {
        role: "user",
        content: message,
      });
      const aiMessage = `I'd be happy to help you book with ${fullName}! Could you please provide their full name (first and last)?`;
      conversationService.addMessage(sessionId, {
        role: "assistant",
        content: aiMessage,
      });
      return { reply: { type: "message", aiMessage } };
    }

    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(" ");

    console.log(
      `[practitioner-handler] search_practitioners("${firstName}", "${lastName}")`,
    );

    conversationService.addMessage(sessionId, {
      role: "user",
      content: message,
    });

    // Call search_practitioners directly
    const practResult = await openAIService.executeFunction(
      "search_practitioners",
      {
        firstName,
        lastName,
      },
    );

    console.log(`[practitioner-handler] Result: ${practResult.type}`);

    if (
      practResult.type === "practitioner_verified" &&
      practResult.practitionerId
    ) {
      conversationService.updateContext(sessionId, {
        practitionerId: practResult.practitionerId,
        practitioner: practResult.practitioner,
      });
    }

    conversationService.addMessage(sessionId, {
      role: "function",
      name: "search_practitioners",
      content: JSON.stringify(practResult),
    });

    // Extract email from the original message
    const emailMatch = message.match(/\b[\w.%+-]+@[\w.-]+\.[a-zA-Z]{2,}\b/);

    if (emailMatch && practResult.type === "practitioner_verified") {
      const email = emailMatch[0];
      console.log(`[practitioner-handler] Also found email: ${email}`);

      const patientResult = await openAIService.executeFunction(
        "search_patient_by_email",
        { email },
      );
      console.log(
        `[practitioner-handler] Patient result: ${patientResult.type}`,
      );

      if (
        patientResult.type === "patient_verified" &&
        patientResult.patientId
      ) {
        conversationService.updateContext(sessionId, {
          patientId: patientResult.patientId,
          patient: patientResult.patient,
        });
      }

      conversationService.addMessage(sessionId, {
        role: "function",
        name: "search_patient_by_email",
        content: JSON.stringify(patientResult),
      });

      // Both practitioner and patient verified → trigger locations
      if (patientResult.type === "patient_verified") {
        const aiMessage = `Perfect! I found ${practResult.practitioner?.name} and verified your account. Let's get you scheduled! 📅`;
        const locResult = await this.autoTrigger(sessionId, "get_locations");
        conversationService.addMessage(sessionId, {
          role: "assistant",
          content: aiMessage,
        });

        return {
          reply: {
            ...locResult,
            aiMessage:
              aiMessage +
              "\n\nPlease select a location from the options above.",
            patientId: patientResult.patientId,
            practitionerId: practResult.practitionerId,
          },
        };
      }

      // Practitioner found but patient not found
      const aiMessage = `Great! I found ${practResult.practitioner?.name}. However, I couldn't find an account with ${email}. Please double-check the spelling and try again, or contact our support team if you haven't registered yet.`;
      conversationService.addMessage(sessionId, {
        role: "assistant",
        content: aiMessage,
      });
      return {
        reply: {
          type: "message",
          aiMessage,
          practitionerId: practResult.practitionerId,
        },
      };
    }

    // No email or practitioner not verified — respond based on practitioner result
    let aiMessage = "";
    if (practResult.type === "practitioner_verified") {
      aiMessage = `Great! I found ${practResult.practitioner?.name}. Please provide your email address to verify your patient account.`;
    } else if (practResult.type === "practitioners_list") {
      aiMessage = `I found ${practResult.count} practitioners with that name. Please specify which one:`;
      conversationService.addMessage(sessionId, {
        role: "assistant",
        content: aiMessage,
      });
      return { reply: { ...practResult, aiMessage } };
    } else {
      aiMessage = this.getFallbackMessage(practResult);
    }

    conversationService.addMessage(sessionId, {
      role: "assistant",
      content: aiMessage,
    });
    return {
      reply: {
        type: "message",
        aiMessage,
        ...(practResult.practitionerId && {
          practitionerId: practResult.practitionerId,
        }),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLE SYSTEM SELECTION
  // Pure deterministic routing — no AI call needed.
  // mergedState already has the selected IDs from the frontend button click.
  // ═══════════════════════════════════════════════════════════════════════════
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

    // ── Slot selected → create appointment ──────────────────────────────────
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

      const freshCtx = conversationService.getContext(sessionId);
      const resolvedAppointmentTypeId =
        mergedState.appointmentTypeId ?? freshCtx?.appointmentTypeId ?? 1;

      const result = await this.autoTrigger(sessionId, "create_appointment", {
        patientId: mergedState.patientId,
        locationId: mergedState.locationId,
        appointmentTypeId: resolvedAppointmentTypeId,
        practitionerId: mergedState.selectedSlot.practitionerId,
        start: mergedState.selectedSlot.start,
        end: mergedState.selectedSlot.end,
      });

      if (result.type === "appointment_confirmed") {
        // ── CRITICAL: Clear all booking context after confirmation ──────────────
        // Without this, the next booking attempt in the same session reuses the
        // old patientId from sessionContext, skipping patient verification entirely.
        conversationService.updateContext(sessionId, {
          patientId: undefined,
          patient: undefined,
          practitionerId: undefined,
          practitioner: undefined,
          isNewPatient: undefined,
          appointmentTypeId: undefined,
          selectedSlot: undefined,
        });
        console.log(
          `[${sessionId}] Appointment confirmed — session context cleared for next booking`,
        );

        // const aiMsg = `🎉 Your appointment has been booked successfully!\n\n${result.message}\n\nIs there anything else I can help you with? If you'd like to book another appointment, just let me know!`;
        const aiMsg = `📅 Your appointment is confirmed!

               ${result.message}

          This booking has been completed successfully.  `;

        return { reply: { ...result, aiMessage: aiMsg } };
      }

      return {
        reply: { ...result, aiMessage: this.getFallbackMessage(result) },
      };
    }

    // ── Practitioner selected from multi-result list ─────────────────────────
    if (message.startsWith("practitioner_")) {
      const practId = parseInt(message.replace("practitioner_", ""), 10);
      conversationService.updateContext(sessionId, { practitionerId: practId });

      // Check if we already have a location selected
      if (mergedState.locationId) {
        // We already have a location, so go straight to slots with the practitioner filter
        console.log(
          `[practitioner-selected] Location already selected (${mergedState.locationId}), fetching slots with practitioner filter`,
        );

        // Get patient status to determine appointment type
        const freshCtx = conversationService.getContext(sessionId);
        const isNewPatient = freshCtx?.isNewPatient ?? false;
        const appointmentTypeId = isNewPatient ? 2 : 1; // New = Initial Assessment, Existing = ONE Adjustment

        // Update context with appointment type
        conversationService.updateContext(sessionId, { appointmentTypeId });

        // Fetch slots with practitioner filter
        const result = await this.autoTrigger(
          sessionId,
          "check_available_slots",
          {
            locationId: mergedState.locationId.toString(),
            appointmentTypeId: appointmentTypeId,
            practitionerId: practId, // Use the newly selected practitioner
          },
        );

        const aiMsg =
          result.data?.length > 0
            ? "Here are the available time slots with your preferred practitioner — please pick one:"
            : "No slots are available at this location for your selection.";

        return {
          reply: {
            type: "available_slots",
            data: result.data,
            aiMessage: aiMsg,
            appointmentTypeId: appointmentTypeId,
            practitionerId: practId,
          },
        };
      }

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

    // ── Location selected ────────────────────────────────────────────────────
    if (mergedState.locationId && !mergedState.appointmentTypeId) {
      const sessionContext = conversationService.getContext(sessionId);

      // Check if this is a new patient (first-time booking)
      if (sessionContext?.isNewPatient === true) {
        // New patient → auto-select "Initial Assessment" (ID: 2)
        console.log(
          `[auto-select] New patient detected, auto-selecting Initial Assessment`,
        );

        const appointmentTypeId = 2; // Initial Assessment

        conversationService.updateContext(sessionId, { appointmentTypeId });

        // Immediately fetch available slots
        const result = await this.autoTrigger(
          sessionId,
          "check_available_slots",
          {
            locationId: mergedState.locationId.toString(),
            appointmentTypeId: appointmentTypeId,
            // practitionerId: sessionContext?.practitionerId ?? undefined,
          },
        );

        // const aiMsg =
        //   result.data?.length > 0
        //     ? "Here are the available time slots for your initial assessment — please pick one:"
        //     : "No slots are available. Would you like to try a different location?";
        const aiMsg =
          result.data?.length > 0
            ? "Here are the available time slots for your initial assessment — please pick one:"
            : "No slots are available at this location for your initial assessment.";

        // return {
        //   reply: {
        //     ...result,
        //     aiMessage: aiMsg,
        //     appointmentTypeId: appointmentTypeId,
        //     practitionerId: sessionContext?.practitionerId,
        //   },
        // };

        return {
          reply: {
            type: "available_slots", // Explicitly set type
            data: result.data,
            aiMessage: aiMsg,
            appointmentTypeId: appointmentTypeId, // ← CRITICAL: Tell frontend
          },
        };
      }

      // Existing patient → auto-select "ONE Adjustment" (ID: 1)
      console.log(
        `[auto-select] Existing patient detected, auto-selecting ONE Adjustment`,
      );

      const appointmentTypeId = 1; // ONE Adjustment

      // ADD THIS LINE RIGHT AFTER:
      conversationService.updateContext(sessionId, { appointmentTypeId });

      // Immediately fetch available slots
      const result = await this.autoTrigger(
        sessionId,
        "check_available_slots",
        {
          locationId: mergedState.locationId.toString(),
          appointmentTypeId: appointmentTypeId,
          practitionerId: sessionContext?.practitionerId ?? undefined,
        },
      );

      const aiMsg =
        result.data?.length > 0
          ? "Here are the available time slots — please pick one:"
          : "No slots are available. Would you like to try a different location?";

      // return {
      //   reply: {
      //     ...result,
      //     aiMessage: aiMsg,
      //     appointmentTypeId: appointmentTypeId, // ← Tell frontend
      //     practitionerId: sessionContext?.practitionerId, // ← Tell frontend
      //   },
      // };

      return {
        reply: {
          type: "available_slots", // Explicitly set type
          data: result.data,
          aiMessage: aiMsg,
          appointmentTypeId: appointmentTypeId, // ← CRITICAL: Tell frontend
          practitionerId: sessionContext?.practitionerId,
        },
      };
    }

    // ── Appointment type selected ────────────────────────────────────────────
    // mergedState.locationId + appointmentTypeId set, no slot yet
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
          : "No slots are available with this practitioner. Would you like to try a different practitioner or location?";
      return { reply: { ...result, aiMessage: aiMsg } };
    }

    // Fallback — let AI handle unexpected selection shape
    return await this.runAIConversation(
      sessionId,
      message,
      mergedState,
      extra,
      sessionContext,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLE UNSUPPORTED DATE REQUEST ("book for today", "tomorrow", etc.)
  // We don't crash or confuse — we explain and continue the flow.
  // ═══════════════════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLE CANCEL / RESCHEDULE REQUEST
  // ═══════════════════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLE BOOKING FOR SOMEONE ELSE (child, spouse, family member)
  // Clears current patient so the other person's email is collected fresh.
  // ═══════════════════════════════════════════════════════════════════════════
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

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLE SCHEDULE APPOINTMENT (welcome button)
  // User clicked "Schedule an Appointment" from the welcome screen
  // ═══════════════════════════════════════════════════════════════════════════
  private async handleScheduleAppointment(
    sessionId: string,
  ): Promise<ChatResponse> {
    const aiMessage =
      "Great! I'll help you schedule an appointment. 📅\n\n" +
      "Would you like to book with a specific practitioner, or see all available appointments?";

    conversationService.addMessage(sessionId, {
      role: "assistant",
      content: aiMessage,
    });
    return { reply: { type: "message", aiMessage } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLE INFO REQUEST (welcome button)
  // User clicked "Learn More" from the welcome screen
  // ═══════════════════════════════════════════════════════════════════════════
  private async handleInfoRequest(sessionId: string): Promise<ChatResponse> {
    const aiMessage =
      "Welcome to One Chiropractic Studio! 🏥\n\n" +
      "We're a network of chiropractic clinics across the Netherlands with locations in Utrecht, Amsterdam, Rotterdam, The Hague, Haarlem, Arnhem, Gouda, and Amersfoort.\n\n" +
      "**Our Services:**\n" +
      "• ONE Adjustment - Regular chiropractic adjustments\n" +
      "• Initial Assessment - Comprehensive first visit evaluation\n\n" +
      "**Why Choose Us:**\n" +
      "✓ Experienced practitioners\n" +
      "✓ Modern facilities\n" +
      "✓ Convenient locations\n" +
      "✓ Easy online booking\n\n" +
      "Would you like to schedule an appointment, or do you have any questions?";

    conversationService.addMessage(sessionId, {
      role: "assistant",
      content: aiMessage,
    });
    return { reply: { type: "message", aiMessage } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLE CORRECTIONS — prerequisite-validated
  // ═══════════════════════════════════════════════════════════════════════════
  private async handleCorrectionByIntent(
    sessionId: string,
    message: string,
    action: string,
    mergedState: any,
  ): Promise<ChatResponse | null> {
    console.log(`[${sessionId}] Correction: ${action}`);

    switch (action) {
      // ── Start over ──────────────────────────────────────────────────────────
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

      // ── Wrong email ─────────────────────────────────────────────────────────
      case "correct_email": {
        conversationService.updateContext(sessionId, {
          patientId: undefined,
          patient: undefined,
        });
        // If new email is already in the message, let the AI path call the function
        if (message.includes("@")) return null;
        return {
          reply: {
            type: "clear_patient",
            aiMessage:
              "No problem! Please provide your correct email address and I'll verify your account.",
          },
        };
      }

      // ── Wrong practitioner ──────────────────────────────────────────────────
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

      // ── Wrong location ──────────────────────────────────────────────────────
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

      // ── Wrong appointment type ──────────────────────────────────────────────
      case "change_appointment_type": {
        // PREREQUISITE: must have a location selected first
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

      // ── Wrong time slot ─────────────────────────────────────────────────────
      case "change_time_slot": {
        // PREREQUISITE: need both location AND appointment type
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

      // ── Unclear correction ──────────────────────────────────────────────────
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
        return null; // Fall through to AI conversation
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NORMAL AI CONVERSATION PATH
  // ═══════════════════════════════════════════════════════════════════════════
  private async runAIConversation(
    sessionId: string,
    message: string,
    mergedState: any,
    extra: any,
    sessionContext: any,
    isGeneralChat = false,
  ): Promise<ChatResponse> {
    conversationService.addMessage(sessionId, {
      role: "user",
      content: message,
    });

    let messages = conversationService.getMessages(sessionId);
    const contextMsg = this.buildContextMessage(
      mergedState,
      extra,
      isGeneralChat,
    );
    if (contextMsg) {
      messages = [...messages, { role: "system", content: contextMsg }];
    }

    const aiResponse = await openAIService.chat(messages);
    const aiMessage = aiResponse.message;

    // ── Function call branch ────────────────────────────────────────────────
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

      if (fnResult.type === "available_slots" && fnResult.appointmentTypeId) {
        // Make sure appointmentTypeId is in the updated context
        conversationService.updateContext(sessionId, {
          appointmentTypeId: fnResult.appointmentTypeId,
        });
      }

      if (fnResult.type === "patient_verified" && fnResult.patientId) {
        conversationService.updateContext(sessionId, {
          patientId: fnResult.patientId,
          patient: fnResult.patient,
          isNewPatient: fnResult.isNewPatient,
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
      const updatedCtxMsg = this.buildContextMessage(
        updatedMerged,
        extra,
        isGeneralChat,
      );
      if (updatedCtxMsg) {
        updatedMessages = [
          ...updatedMessages,
          { role: "system", content: updatedCtxMsg },
        ];
      }

      const followUp = await openAIService.chat(updatedMessages);
      let finalMessage = followUp.message?.content || "";
      // if (!finalMessage || finalMessage.includes("I couldn't generate")) {
      //   finalMessage = this.getFallbackMessage(fnResult);
      // }

      // For available_slots, never let AI describe the slots in text
      if (fnResult.type === "available_slots") {
        const freshCtx = conversationService.getContext(sessionId);
        // finalMessage =
        //   fnResult.data?.length > 0
        //     ? "Here are the available time slots — please pick one:"
        //     : "No slots are available at this location.";

        finalMessage =
          fnResult.data?.length > 0
            ? freshCtx?.isNewPatient
              ? `Thanks! 🙏 Please select from the available slots below for your initial assessment:`
              : "Here are the available time slots — please pick one:"
            : "No slots are available at this location.";
      } else if (
        !finalMessage ||
        finalMessage.includes("I couldn't generate")
      ) {
        finalMessage = this.getFallbackMessage(fnResult);
      }

      conversationService.addMessage(sessionId, {
        role: "assistant",
        content: finalMessage,
      });

      // Auto-trigger next step
      const autoResult = await this.checkAndTriggerNextStep(
        sessionId,
        fnResult,
        isGeneralChat,
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

    // ── Plain text branch ───────────────────────────────────────────────────
    const textMessage = aiMessage?.content || "How can I help you?";
    conversationService.addMessage(sessionId, {
      role: "assistant",
      content: textMessage,
    });
    return { reply: { type: "message", aiMessage: textMessage } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-TRIGGER NEXT STEP after AI function calls
  //
  // CRITICAL: We ONLY use the server-side sessionContext to check patientId.
  // The frontend bookingState can be stale (e.g. old patientId from a prior
  // session still sitting in the browser). Using mergedState here would cause
  // get_locations to fire before the patient is actually verified in this session.
  // ═══════════════════════════════════════════════════════════════════════════
  // private async checkAndTriggerNextStep(
  //   sessionId: string,
  //   fnResult: any,
  //   isGeneralChat = false,
  // ): Promise<any> {
  //   try {
  //     if (isGeneralChat) return null;

  //     if (fnResult.type === "appointment_confirmed") return null;

  //     // Read the freshest server-side context — this is updated immediately
  //     // after executeFunction stores patientId/practitionerId.
  //     const freshCtx = conversationService.getContext(sessionId);

  //     // After practitioner verified: ONLY proceed to locations if patient
  //     // is confirmed server-side (freshCtx.patientId set in this session).
  //     if (fnResult.type === "practitioner_verified") {
  //       if (freshCtx?.patientId) {
  //         console.log(
  //           `[auto-trigger] get_locations (patient already verified server-side)`,
  //         );
  //         return await this.autoTrigger(sessionId, "get_locations");
  //       }
  //       // Patient not yet verified — wait for email
  //       return null;
  //     }

  //     // After patient verified: always show locations
  //     if (fnResult.type === "patient_verified") {
  //       console.log(`[auto-trigger] get_locations after patient_verified`);
  //       return await this.autoTrigger(sessionId, "get_locations");
  //     }

  //     return null;
  //   } catch (err) {
  //     console.error("[checkAndTriggerNextStep] error:", err);
  //     return null;
  //   }
  // }

  private async checkAndTriggerNextStep(
    sessionId: string,
    fnResult: any,
    isGeneralChat = false,
  ): Promise<any> {
    try {
      if (isGeneralChat) return null;

      if (fnResult.type === "appointment_confirmed") return null;

      // Read the freshest server-side context — this is updated immediately
      // after executeFunction stores patientId/practitionerId.
      const freshCtx = conversationService.getContext(sessionId);

      // Also check if we have a location from the frontend state
      // We need to access the mergedState here, but since this method doesn't have it,
      // we need to modify the method signature or store it in the context

      // For now, let's check if we have a location in the context or we can check
      // by looking at the conversation state

      // After practitioner verified: ONLY proceed to locations if patient
      // is confirmed server-side AND we don't already have a location
      if (fnResult.type === "practitioner_verified") {
        if (freshCtx?.patientId) {
          // Check if we already have a location in the context
          // Since we don't store location in context, we need to check the frontend state
          // For now, let's add a check in the conversation context
          console.log(
            `[auto-trigger] practitioner_verified - checking if location already selected`,
          );

          // We'll return null here and let the frontend handle it
          // The frontend will send the practitioner_* message which will be handled
          // by handleSystemSelection where we already have the location check
          return null;
        }
        // Patient not yet verified — wait for email
        return null;
      }

      // After patient verified: only show locations if no location is selected
      if (fnResult.type === "patient_verified") {
        // Check if location is already selected in the frontend state
        // Since we don't have access to mergedState here, we'll return null
        // The frontend will handle the flow based on existing location
        console.log(
          `[auto-trigger] patient_verified - letting frontend handle flow`,
        );
        return null;
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

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD CONTEXT MESSAGE — injected as system message every turn
  // ═══════════════════════════════════════════════════════════════════════════
  // private buildContextMessage(
  //   mergedState: any,
  //   extra?: any,
  //   isGeneralChat = false,
  // ): string | null {
  //   if (isGeneralChat) {
  //     return [
  //       "MODE: General information chat.",
  //       "The user clicked 'Chat With Us' — they want to learn about services,",
  //       "locations, pricing, hours, or have general questions.",
  //       "Do NOT ask for email, name, or any patient verification.",
  //       "Do NOT trigger any booking functions.",
  //       "Answer questions warmly and helpfully.",
  //       "If the user wants to book, tell them to click 'Schedule an Appointment'.",
  //     ].join("\n");
  //   }

  //   const parts: string[] = ["CURRENT BOOKING STATE:"];

  //   if (mergedState.practitionerId) {
  //     parts.push(`- Practitioner ID: ${mergedState.practitionerId} (selected)`);
  //   }

  //   if (!mergedState.patientId) {
  //     parts.push(`- Patient: NOT VERIFIED`);
  //     parts.push(
  //       `  ⚠ Must call search_patient_by_email(email) before any other step.`,
  //     );
  //   } else {
  //     parts.push(`- Patient ID: ${mergedState.patientId} (verified)`);
  //   }

  //   parts.push(`- Location ID: ${mergedState.locationId ?? "not selected"}`);
  //   parts.push(
  //     `- Appointment Type ID: ${mergedState.appointmentTypeId ?? "not selected"}`,
  //   );

  //   if (mergedState.selectedSlot) {
  //     const s = mergedState.selectedSlot;
  //     parts.push(
  //       `- Slot: ${s.start} → ${s.end} (Practitioner: ${s.practitionerId})`,
  //     );
  //   }

  //   if (extra?.start && extra?.end) {
  //     parts.push(`- Extra slot: ${extra.start} → ${extra.end}`);
  //   }

  //   parts.push("");

  //   if (!mergedState.patientId) {
  //     parts.push(
  //       "NEXT: Patient unverified. Ask for email → call search_patient_by_email.",
  //     );
  //   } else if (!mergedState.locationId) {
  //     parts.push(
  //       "NEXT: Show locations (system will auto-trigger get_locations).",
  //     );
  //   } else if (!mergedState.appointmentTypeId) {
  //     parts.push(
  //       "NEXT: Show appointment types (system will auto-trigger get_appointment_types).",
  //     );
  //   } else if (!mergedState.selectedSlot) {
  //     parts.push(
  //       "NEXT: Show available slots (system will auto-trigger check_available_slots).",
  //     );
  //   } else {
  //     parts.push(
  //       "NEXT: Create the appointment (system will auto-trigger create_appointment).",
  //     );
  //   }

  //   if (mergedState.practitionerId && mergedState.appointmentTypeId) {
  //     parts.push(
  //       `NOTE: Filter slots by practitionerId = ${mergedState.practitionerId}.`,
  //     );
  //   }

  //   return parts.join("\n");
  // }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILD CONTEXT MESSAGE — injected as system message every turn
  // ═══════════════════════════════════════════════════════════════════════════
  private buildContextMessage(
    mergedState: any,
    extra?: any,
    isGeneralChat = false,
  ): string | null {
    if (isGeneralChat) {
      return [
        "MODE: General information chat.",
        "The user clicked 'Chat With Us' — they want to learn about services,",
        "locations, pricing, hours, or have general questions.",
        "Do NOT ask for email, name, or any patient verification.",
        "Do NOT trigger any booking functions.",
        "Answer questions warmly and helpfully.",
        "If the user wants to book, tell them to click 'Schedule an Appointment'.",
      ].join("\n");
    }

    const parts: string[] = ["CURRENT BOOKING STATE:"];

    if (mergedState.practitionerId) {
      parts.push(`- Practitioner ID: ${mergedState.practitionerId} (selected)`);
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

    // Show appointment type status - but it's handled automatically
    if (mergedState.patientId && mergedState.locationId) {
      // Appointment type is auto-selected based on patient status
      parts.push(`- Appointment Type: AUTO-SELECTED (not shown to user)`);
    } else {
      parts.push(`- Appointment Type: not applicable yet`);
    }

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

    // ⚠️ CRITICAL FIX: Never suggest appointment types as a next step
    if (!mergedState.patientId) {
      parts.push(
        "NEXT: Patient unverified. Ask for email → call search_patient_by_email.",
      );
    } else if (!mergedState.locationId) {
      parts.push(
        "NEXT: Show locations (system will auto-trigger get_locations).",
      );
    } else if (!mergedState.selectedSlot) {
      parts.push(
        "NEXT: Location selected and patient verified. Auto-select appointment type based on patient status (NEW: Initial Assessment ID 2, EXISTING: ONE Adjustment ID 1) and show available slots.",
      );
      parts.push(
        "IMPORTANT: DO NOT ask for appointment type - it's handled automatically in the background.",
      );
      parts.push(
        "DO NOT call get_appointment_types - the system will fetch slots directly with the appropriate appointment type.",
      );
    } else {
      parts.push(
        "NEXT: Create the appointment (system will auto-trigger create_appointment).",
      );
    }

    if (mergedState.practitionerId && mergedState.locationId) {
      parts.push(
        `NOTE: Filter slots by practitionerId = ${mergedState.practitionerId}.`,
      );
    }

    return parts.join("\n");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FALLBACK MESSAGES
  // ═══════════════════════════════════════════════════════════════════════════
  private getFallbackMessage(fnResult: any): string {
    switch (fnResult.type) {
      case "practitioner_verified":
        return `Great! I found ${fnResult.practitioner?.name}. Please provide your email address to verify your account.`;
      case "practitioner_not_found":
        return "I couldn't find that practitioner. Please check the spelling, or let me know if you'd like to see all available appointments.";
      case "patient_verified":
        const firstName = fnResult.patient?.first_name || "there";
        return `Verified! Welcome, ${firstName}. Please select a location from the options above.`;
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
      // case "appointment_confirmed":
      //   return "🎉 Your appointment has been booked successfully! Is there anything else I can help you with?";
      default:
        return "How can I help you next?";
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN ROUTES
  // ═══════════════════════════════════════════════════════════════════════════
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
