import {
  ChatMessage,
  ConversationHistory,
  AppointmentData,
} from "../types/chat.types";

export class ConversationService {
  private conversations = new Map<string, ConversationHistory>();
  private readonly MAX_HISTORY = 20;
  private readonly SESSION_TIMEOUT = 24 * 60 * 60 * 1000;

  // Get or create a conversation session
  getOrCreateSession(sessionId: string): ConversationHistory {
    if (!this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, {
        sessionId,
        messages: [],
        lastUpdated: new Date(),
        metadata: {
          patientSearchAttempts: 0,
          lastPatientSearchData: null,
        },
      });
      console.log(`Created new conversation session: ${sessionId}`);
    } else {
      // Update last accessed time
      const session = this.conversations.get(sessionId)!;
      session.lastUpdated = new Date();
    }
    return this.conversations.get(sessionId)!;
  }

  // Add a message to the conversation
  addMessage(sessionId: string, message: ChatMessage): void {
    const session = this.getOrCreateSession(sessionId);
    session.messages.push(message);
    session.lastUpdated = new Date();

    // Keep only recent messages to manage token usage
    if (session.messages.length > this.MAX_HISTORY) {
      session.messages = session.messages.slice(-this.MAX_HISTORY);
    }

    this.conversations.set(sessionId, session);
    console.log(
      `Added message to session ${sessionId}. Total messages: ${session.messages.length}`,
    );
  }

  // Get all messages for a session
  getMessages(sessionId: string): ChatMessage[] {
    const session = this.conversations.get(sessionId);
    return session?.messages || [];
  }

  // Get the full conversation history
  getSession(sessionId: string): ConversationHistory | undefined {
    return this.conversations.get(sessionId);
  }

  // Update context data for a session
  updateContext(sessionId: string, context: Partial<AppointmentData>): void {
    const session = this.getOrCreateSession(sessionId);
    session.context = {
      ...session.context,
      ...context,
    };
    this.conversations.set(sessionId, session);
  }

  // Get context data for a session
  getContext(sessionId: string): AppointmentData | undefined {
    return this.conversations.get(sessionId)?.context;
  }

  // Track patient search attempts
  incrementPatientSearchAttempts(sessionId: string, searchData: any): void {
    const session = this.getOrCreateSession(sessionId);
    if (!session.metadata) {
      session.metadata = {};
    }
    session.metadata.patientSearchAttempts =
      (session.metadata.patientSearchAttempts || 0) + 1;
    session.metadata.lastPatientSearchData = searchData;
    this.conversations.set(sessionId, session);
    console.log(
      `Patient search attempt #${session.metadata.patientSearchAttempts} for session ${sessionId}`,
    );
  }

  // Get patient search attempts count
  getPatientSearchAttempts(sessionId: string): number {
    const session = this.conversations.get(sessionId);
    return session?.metadata?.patientSearchAttempts || 0;
  }

  // Clear patient search attempts
  clearPatientSearchAttempts(sessionId: string): void {
    const session = this.conversations.get(sessionId);
    if (session?.metadata) {
      session.metadata.patientSearchAttempts = 0;
      session.metadata.lastPatientSearchData = null;
      this.conversations.set(sessionId, session);
      console.log(`Cleared patient search attempts for session ${sessionId}`);
    }
  }

  // Clear a specific session
  clearSession(sessionId: string): void {
    this.conversations.delete(sessionId);
    console.log(`Cleared session: ${sessionId}`);
  }

  // Reset booking state while keeping patient verification
  resetBookingState(sessionId: string, keepPatient: boolean = true): void {
    const session = this.conversations.get(sessionId);
    if (session?.context) {
      const patientData = keepPatient
        ? {
            patientId: session.context.patientId,
            patient: session.context.patientInfo,
          }
        : {};

      session.context = {
        ...patientData,
        locationId: undefined,
        appointmentTypeId: undefined,
        selectedSlot: undefined,
      };

      this.conversations.set(sessionId, session);
      console.log(
        `Reset booking state for session ${sessionId} (keepPatient: ${keepPatient})`,
      );
    }
  }

  //Get total number of active sessions
  getActiveSessionCount(): number {
    return this.conversations.size;
  }

  // Clean up old sessions
  cleanupOldSessions(): void {
    const now = new Date();
    let cleanedCount = 0;

    for (const [sessionId, session] of this.conversations.entries()) {
      const timeSinceLastUpdate = now.getTime() - session.lastUpdated.getTime();

      if (timeSinceLastUpdate > this.SESSION_TIMEOUT) {
        this.conversations.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`Cleaned up ${cleanedCount} old sessions`);
    }
  }

  getAllSessionIds(): string[] {
    return Array.from(this.conversations.keys());
  }
}

export const conversationService = new ConversationService();

// Run cleanup every hour
setInterval(
  () => {
    conversationService.cleanupOldSessions();
  },
  60 * 60 * 1000,
);
