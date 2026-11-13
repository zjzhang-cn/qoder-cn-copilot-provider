import type { BackendProfile } from "./backend";
import { PROVIDER_GROUP_NAME, SECRET_KEY, VENDOR } from "./config";

export const DIRECT_PROFILE: BackendProfile = {
  id: "direct",
  vendor: VENDOR,
  displayName: "Qoder (Direct)",
  groupName: PROVIDER_GROUP_NAME,
  secretKey: SECRET_KEY,
  cacheKey: "qoder-direct.models.v1",
  configSection: "qoderDirect",
  setup: {
    signIn: "qoderDirect.signIn",
    importPat: "qoderDirect.importPat",
    signOut: "qoderDirect.signOut",
    createGroup: "qoderDirect.createProviderGroup",
    showLogs: "qoderDirect.showLogs",
  },
};
