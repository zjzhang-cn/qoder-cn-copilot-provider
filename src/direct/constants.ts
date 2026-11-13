/** Fixed protocol constants for the Qoder CN direct backend. */

export const CN_WEBSITE = "https://qoder.com.cn";
export const CN_OPENAPI = "https://openapi.qoder.com.cn";
export const CN_GATEWAY = "https://gateway.qoder.com.cn";
export const VPC_DOMAIN_SUFFIX = "vpc.qoder.com.cn";

export const CN_CLIENT_ID = "1c5e33e1-364d-4ce6-b02c-acaa81274a5c";
export const CN_REDIRECT_URI = "qoder-work-cn://";
export const CN_USER_AGENT = "QoderWork/1.1.75";
export const CN_LOGIN_USER_AGENT = "QoderWork";

export const MODELS_PATH = "/algo/api/v2/model/list?Encode=1";
export const CHAT_PATH =
  "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

export const DEVICE_POLL_PATH = "/api/v1/deviceToken/poll";
export const DEVICE_REFRESH_PATH = "/api/v1/deviceToken/refresh";
export const JOB_EXCHANGE_PATH = "/api/v1/jobToken/exchange";
export const JOB_REFRESH_PATH = "/api/v1/jobToken/refresh";
export const USERINFO_PATH = "/api/v1/userinfo";
export const QUOTA_PATH = "/api/v2/quota/usage";

export const COSY_VERSION = "1.1.75";
export const COSY_CLIENT_TYPE = "5";
export const COSY_USER_AGENT = "undici";
export const COSY_CLIENT_IP = "169.254.198.161";
export const LOGIN_VERSION = "v2";
export const DEFAULT_USER_TYPE = "personal_professional_trial";
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Upstream markers meaning the session is dead and re-authentication is
 * required (same set as the qoder2api hub). Matched against error text.
 */
export const SESSION_DEAD_MARKERS = [
  "TOKEN_EXPIRE",
  "12153",
  "Offline user session not found",
] as const;

/** Qoder's public COSY key (not a secret). */
export const COSY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** Standard Base64 alphabet → Qoder custom alphabet. */
export const QODER_ALPHABET =
  "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
