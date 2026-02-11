import dotenv from "dotenv";

dotenv.config();

export const config = {
  server: {
    port: parseInt(process.env.PORT || "3000", 10),
    host: process.env.HOST || "0.0.0.0",
    env: process.env.NODE_ENV || "development",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: "gpt-4o-mini",
  },
  practitionerHub: {
    apiKey: process.env.PH_API_KEY || "",
    baseUrl:
      process.env.PH_API_BASE_URL ||
      "https://onechiropracticstudio.neptune.practicehub.io/api",
    appDetails: process.env.PH_APP_DETAILS,
  },
  cors: {
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",") || ["*"],
  },
};

// Validate required environment variables
const requiredEnvVars = ["OPENAI_API_KEY", "PH_API_KEY", "PH_APP_DETAILS"];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}
