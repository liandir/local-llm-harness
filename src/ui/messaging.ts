/**
 * Compatibility facade for the shared extension/webview protocol.
 * New code may import from `chat/protocol`; existing webview imports stay stable.
 */
export { HOST_MESSAGE_LIMITS, parseChatToExt, parseSideToExt } from "../chat/protocol.js";
export type {
  ChatMessageDto,
  ChatRecordDto,
  ChatSummaryDto,
  ChatToExt,
  ExtToChat,
  ExtToSide,
  OpenChatDto,
  SideSettingUpdate,
  SideTab,
  SideToExt,
  ToolCategory,
  UiEvent
} from "../chat/protocol.js";
