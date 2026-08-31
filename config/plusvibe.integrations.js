const dotenv = require("dotenv");

dotenv.config();

const plusvibeConfig = {
  apiKey: process.env.PLUSVIBE_API_KEY,
  baseUrl: process.env.PLUSVIBE_BASE_URL || "https://api.plusvibe.ai/api/v1",
  workspaceId: process.env.PLUSVIBE_WORKSPACE_ID,
  timeoutMs: Number(process.env.PLUSVIBE_TIMEOUT_MS || 30000),
};

const validatePlusvibeConfig = () => {
  const missingKeys = ["apiKey"].filter((key) => !plusvibeConfig[key]);

  if (missingKeys.length) {
    throw new Error(
      `Missing Plusvibe configuration: ${missingKeys.join(", ")}`
    );
  }

  return plusvibeConfig;
};

module.exports = {
  plusvibeConfig,
  validatePlusvibeConfig,
};
