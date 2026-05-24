import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatterRole } from "../../definitions/chatter";
import type { RoleContext } from "../../base-role";
import type { ChatterRoleConfig, HubMessage, HubResult, ReplyChannel } from "../../../types";

const ADS_REPLY_CHANNEL: ReplyChannel = {
  channel: "socket",
  chat_id: "ads:demo",
  socket_path: "/tmp/ads.sock"
};

describe("ChatterRole agent structured fallback", () => {
  it("turns a textual chatter.suggest_observation fallback into a candidate event", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-fallback-candidate-")));
    const { role, sent } = await activateRole(root, {
      skill_allowlist: ["chatter.suggest_observation"]
    });
    const run = await startBoundTurn(role, sent, {
      system_prompt_id: "optimize_from_template",
      chatter_session_id: "ads-session-1"
    });

    await role.onInboundResult(makeAgentResult(run, "claude_07", [
      "我会先给出一个候选建议。",
      "```json",
      JSON.stringify({
        mumu_structured_fallback: {
          tool: "chatter.suggest_observation",
          args: {
            type: "story_patch",
            description: "把第一段改成更直接的身份反转钩子，先抓住观众注意力。",
            proposed_patch: {
              record_type: "story_short_drama",
              key: "story-1",
              patch: {
                outline: {
                  arc: "开场直接揭示误会来源。"
                }
              }
            }
          }
        }
      }),
      "```"
    ].join("\n")));

    const candidate = sent.find((msg) => msg.payload.chatter?.candidate_observation);
    expect(candidate?.payload.chatter?.candidate_observation).toMatchObject({
      observation_id: expect.any(String),
      type: "story_patch",
      proposed_patch: {
        record_type: "story_short_drama",
        key: "story-1"
      }
    });
    const finalReply = sent.filter((msg) => msg.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id).at(-1);
    expect(finalReply?.payload.chatter?.chatter_session_id).toBe("ads-session-1");
    expect(finalReply?.payload.content).not.toContain("mumu_structured_fallback");
  });

  it("copies a textual payload.chatter.extract_state fallback onto the final reply", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chatter-fallback-extract-")));
    const { role, sent } = await activateRole(root);
    const run = await startBoundTurn(role, sent, {
      system_prompt_id: "extract_template_from_draft",
      chatter_session_id: "ads-session-2"
    });

    await role.onInboundResult(makeAgentResult(run, "claude_07", [
      "已收到剧本，我先确认体裁。",
      "```json",
      JSON.stringify({
        payload: {
          chatter: {
            extract_state: {
              stage: "asking_genre",
              question: "这是哪种内容体裁？",
              options: ["短剧", "连线", "抖音"]
            }
          }
        }
      }),
      "```"
    ].join("\n")));

    const finalReply = sent.filter((msg) => msg.reply_channel.chat_id === ADS_REPLY_CHANNEL.chat_id).at(-1);
    expect(finalReply?.payload.chatter?.extract_state).toEqual({
      stage: "asking_genre",
      question: "这是哪种内容体裁？",
      options: ["短剧", "连线", "抖音"]
    });
    expect(finalReply?.payload.chatter?.chatter_session_id).toBe("ads-session-2");
    expect(finalReply?.payload.content).not.toContain("extract_state");
  });
});

async function activateRole(
  root: string,
  overrides: Partial<ChatterRoleConfig> = {}
): Promise<{ role: ChatterRole; sent: HubMessage[] }> {
  const { ctx, sent } = makeCtx();
  const role = new ChatterRole("chatter-tenant-a", {
    chatter_id: "tenant-a",
    memory_folder: root,
    manifest_path: writeManifest(root),
    allowed_modes: ["stateless", "session"],
    skill_allowlist: [],
    llm_agent_kind: "claude-code",
    user_reply_channel: ADS_REPLY_CHANNEL,
    ...overrides
  });
  await role.onActivate(ctx);
  return { role, sent };
}

async function startBoundTurn(
  role: ChatterRole,
  sent: HubMessage[],
  chatter: NonNullable<HubMessage["payload"]["chatter"]>
): Promise<HubMessage> {
  await role.onInboundResult({
    trace_id: crypto.randomUUID(),
    thread_id: "chatter-tenant-a",
    source: "ads",
    status: "success",
    content: "请处理这轮请求",
    attachments: [],
    timestamp: new Date().toISOString(),
    payload: { chatter: { mode: "session", ...chatter } }
  });
  const spawn = sent.find((msg) => msg.intent === "spawn");
  expect(spawn).toBeDefined();
  await role.onInboundResult(makeAgentResult(spawn!, "claude_07", "spawned claude_07"));
  const run = sent.find((msg) => msg.intent === "run" && msg.target === "claude_07");
  expect(run).toBeDefined();
  return run!;
}

function makeAgentResult(message: HubMessage, threadId: string, content: string): HubResult {
  return {
    trace_id: message.trace_id,
    thread_id: threadId,
    source: "claude",
    status: "success",
    run_state: "completed",
    content,
    attachments: [],
    timestamp: new Date().toISOString()
  };
}

function makeCtx(): { ctx: RoleContext; sent: HubMessage[] } {
  const sent: HubMessage[] = [];
  return {
    sent,
    ctx: {
      sendToHub: async (msg) => {
        sent.push(msg as HubMessage);
      },
      listInstances: async () => [],
      log: { debug() {}, info() {}, warn() {}, error() {} }
    }
  };
}

function writeManifest(root: string): string {
  const manifestPath = path.join(root, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      layers: "flat",
      index: "none",
      bindings: {},
      system_prompts: {
        optimize_from_template: { prompt_path: path.join(root, "optimize.md") },
        extract_template_from_draft: { prompt_path: path.join(root, "extract.md") }
      }
    })
  );
  writeFileSync(path.join(root, "optimize.md"), "optimize");
  writeFileSync(path.join(root, "extract.md"), "extract");
  return manifestPath;
}
