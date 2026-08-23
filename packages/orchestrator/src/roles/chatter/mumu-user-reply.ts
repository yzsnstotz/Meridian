export const MUMU_USER_REPLY_START = "<<<MUMU-USER-REPLY>>>";
export const MUMU_USER_REPLY_END = "<<<END-MUMU-USER-REPLY>>>";
export const MUMU_USER_REPLY_FALLBACK =
  "已生成初稿，我把结构放在右侧。你可以继续让我展开、修改或换一个方向。";

export type MumuUserReplyParseStatus =
  | "parsed"
  | "missing_markers"
  | "reversed_markers"
  | "unterminated_block"
  | "empty_block"
  | "unsafe_content";

export interface MumuUserReplyParseDiagnostics {
  ok: boolean;
  status: MumuUserReplyParseStatus;
  fallback_used: boolean;
  valid_block_count: number;
}

export interface MumuUserReplyParseResult extends MumuUserReplyParseDiagnostics {
  content: string;
}

const UNSAFE_USER_REPLY_PATTERNS: RegExp[] = [
  /\/data\/mumu\//iu,
  /structured\//iu,
  /\.json\b/iu,
  /\bstory_(short_drama|lianxian|douyin|variety)\b/iu,
  /\btemplate_(short_drama|lianxian|douyin|variety)\b/iu,
  /\bstyle_(short_drama|lianxian|douyin|variety)\b/iu,
  /\bvisual_beats\b/iu,
  /\btemplate_id\b/iu,
  /\brecord_type\b/iu,
  /JSON\s*校验/iu,
  /记忆文件夹/iu,
  /字段形态/iu,
  /已写入/iu,
  /我会先/iu
];

export const mumuUserReplyParseDiagnostics = (
  result: MumuUserReplyParseResult
): MumuUserReplyParseDiagnostics => ({
  ok: result.ok,
  status: result.status,
  fallback_used: result.fallback_used,
  valid_block_count: result.valid_block_count
});

export const containsUnsafeMumuUserReplyContent = (content: string): boolean =>
  UNSAFE_USER_REPLY_PATTERNS.some((pattern) => pattern.test(content));

export const fallbackMumuUserReply = (
  status: Exclude<MumuUserReplyParseStatus, "parsed">,
  validBlockCount: number
): MumuUserReplyParseResult => ({
  ok: false,
  status,
  content: MUMU_USER_REPLY_FALLBACK,
  fallback_used: true,
  valid_block_count: validBlockCount
});

export const parseMumuUserReply = (rawContent: string): MumuUserReplyParseResult => {
  const raw = String(rawContent);
  const firstStart = raw.indexOf(MUMU_USER_REPLY_START);
  const firstEnd = raw.indexOf(MUMU_USER_REPLY_END);

  if (firstEnd !== -1 && (firstStart === -1 || firstEnd < firstStart)) {
    return fallbackMumuUserReply("reversed_markers", 0);
  }

  const blocks: string[] = [];
  let searchIndex = 0;
  let unterminated = false;

  while (searchIndex < raw.length) {
    const startIndex = raw.indexOf(MUMU_USER_REPLY_START, searchIndex);
    if (startIndex === -1) {
      break;
    }
    const contentStart = startIndex + MUMU_USER_REPLY_START.length;
    const endIndex = raw.indexOf(MUMU_USER_REPLY_END, contentStart);
    if (endIndex === -1) {
      unterminated = true;
      break;
    }
    blocks.push(raw.slice(contentStart, endIndex));
    searchIndex = endIndex + MUMU_USER_REPLY_END.length;
  }

  if (unterminated) {
    return fallbackMumuUserReply("unterminated_block", blocks.length);
  }
  if (blocks.length === 0) {
    return fallbackMumuUserReply(firstStart === -1 ? "missing_markers" : "unterminated_block", 0);
  }

  const content = blocks[blocks.length - 1]!.trim();
  if (!content) {
    return fallbackMumuUserReply("empty_block", blocks.length);
  }
  if (containsUnsafeMumuUserReplyContent(content)) {
    return fallbackMumuUserReply("unsafe_content", blocks.length);
  }

  return {
    ok: true,
    status: "parsed",
    content,
    fallback_used: false,
    valid_block_count: blocks.length
  };
};
