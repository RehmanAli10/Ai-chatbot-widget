import axios from "axios";
import { config } from "./env.config";

export const practitionerHubClient = axios.create({
  baseURL: config.practitionerHub.baseUrl,
  headers: {
    "x-practicehub-key": config.practitionerHub.apiKey,
    "x-app-details": config.practitionerHub.appDetails,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  timeout: 15000,
});

// Add request interceptor for logging
practitionerHubClient.interceptors.request.use(
  (requestConfig) => {
    console.log(
      `[Practitioner Hub] ${requestConfig.method?.toUpperCase()} ${requestConfig.url}`,
    );
    return requestConfig;
  },
  (error) => {
    return Promise.reject(error);
  },
);

// Add response interceptor for error handling
practitionerHubClient.interceptors.response.use(
  (response) => {
    console.log(
      `[Practitioner Hub] Response ${response.status}: ${response.config.url}`,
    );
    return response;
  },
  (error) => {
    if (error.response) {
      console.error(
        `[Practitioner Hub Error] ${error.response.status}: ${JSON.stringify(
          error.response.data,
        )}`,
      );
    } else if (error.request) {
      console.error(
        "[Practitioner Hub Error] No response received:",
        error.message,
      );
    } else {
      console.error("[Practitioner Hub Error]", error.message);
    }
    return Promise.reject(error);
  },
);

export const PRACTITIONER_HUB_CONFIG = {
  apiKey: config.practitionerHub.apiKey,
  baseUrl: config.practitionerHub.baseUrl,
  appDetails: config.practitionerHub.appDetails,
};
