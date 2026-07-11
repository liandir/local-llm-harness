/**
 * Compatibility facade. New code should import from `catalog.ts` directly;
 * these exports remain stable while session orchestration is modularized.
 */
export {
  ALLOWED_TOOL_NAMES,
  classifyToolName,
  disabledToolReason,
  DISABLED_TOOL_NAMES,
  isForbiddenToolName,
  type ToolNameClassification
} from "./catalog.js";
