import { describe, expect, it } from "vitest";

import {
  MUMU_USER_REPLY_FALLBACK,
  parseMumuUserReply
} from "../mumu-user-reply";

describe("parseMumuUserReply", () => {
  it("extracts exactly one valid user reply block", () => {
    const parsed = parseMumuUserReply(
      "internal notes\n<<<MUMU-USER-REPLY>>>\n  这是给用户看的回复。  \n<<<END-MUMU-USER-REPLY>>>\nmore notes"
    );

    expect(parsed).toMatchObject({
      ok: true,
      status: "parsed",
      content: "这是给用户看的回复。",
      fallback_used: false,
      valid_block_count: 1
    });
  });

  it("chooses the last valid block when earlier draft blocks exist", () => {
    const parsed = parseMumuUserReply(
      "draft <<<MUMU-USER-REPLY>>>第一版<<<END-MUMU-USER-REPLY>>>\n"
        + "final <<<MUMU-USER-REPLY>>>最终给用户看的版本<<<END-MUMU-USER-REPLY>>>"
    );

    expect(parsed.content).toBe("最终给用户看的版本");
    expect(parsed.valid_block_count).toBe(2);
  });

  it.each([
    ["missing markers", "我会先检查 structured/story_douyin/a.json", "missing_markers"],
    ["empty content", "<<<MUMU-USER-REPLY>>>\n \n<<<END-MUMU-USER-REPLY>>>", "empty_block"],
    ["reversed markers", "<<<END-MUMU-USER-REPLY>>>oops<<<MUMU-USER-REPLY>>>", "reversed_markers"],
    ["unterminated block", "<<<MUMU-USER-REPLY>>>还没结束", "unterminated_block"],
    [
      "unsafe content",
      "<<<MUMU-USER-REPLY>>>已写入 structured/story_douyin/a.json，JSON 校验通过<<<END-MUMU-USER-REPLY>>>",
      "unsafe_content"
    ]
  ])("uses fallback for %s", (_name, raw, status) => {
    const parsed = parseMumuUserReply(raw);

    expect(parsed).toMatchObject({
      ok: false,
      status,
      content: MUMU_USER_REPLY_FALLBACK,
      fallback_used: true
    });
  });
});
