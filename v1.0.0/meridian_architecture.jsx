import { useState } from "react";

const COLORS = {
  bg: "#0D1117",
  surface: "#161B22",
  surfaceHigh: "#1C2230",
  border: "#30363D",
  borderBright: "#484F58",
  blue: "#58A6FF",
  blueDeep: "#1F6FEB",
  blueDim: "#1A3A6B",
  green: "#3FB950",
  greenDim: "#1A3A28",
  amber: "#D29922",
  amberDim: "#3A2C0A",
  purple: "#BC8CFF",
  purpleDim: "#2D1F5A",
  teal: "#39C5CF",
  tealDim: "#0D3035",
  red: "#F85149",
  redDim: "#3A1215",
  gray: "#8B949E",
  white: "#E6EDF3",
  dimText: "#7D8590",
};

const styles = {
  root: {
    background: COLORS.bg,
    minHeight: "100vh",
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
    color: COLORS.white,
    padding: "32px 24px",
  },
  title: {
    fontSize: "22px",
    fontWeight: 700,
    color: COLORS.blue,
    letterSpacing: "0.05em",
    marginBottom: "4px",
  },
  subtitle: {
    fontSize: "12px",
    color: COLORS.dimText,
    marginBottom: "32px",
    letterSpacing: "0.08em",
  },
  legend: {
    display: "flex",
    gap: "20px",
    flexWrap: "wrap",
    marginBottom: "28px",
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "11px",
    color: COLORS.dimText,
  },
  legendDot: (color) => ({
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    background: color,
  }),
};

function Layer({ label, sublabel, color, dimColor, children, style = {} }) {
  return (
    <div style={{
      border: `1px solid ${color}44`,
      borderRadius: "10px",
      background: dimColor,
      padding: "16px",
      marginBottom: "12px",
      position: "relative",
      ...style,
    }}>
      <div style={{
        position: "absolute",
        top: "-10px",
        left: "14px",
        background: COLORS.bg,
        padding: "0 8px",
        fontSize: "10px",
        fontWeight: 700,
        color: color,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
      }}>
        {label}
      </div>
      {sublabel && (
        <div style={{
          fontSize: "10px",
          color: COLORS.dimText,
          marginBottom: "10px",
          marginTop: "4px",
        }}>
          {sublabel}
        </div>
      )}
      {children}
    </div>
  );
}

function Box({ label, sublabel, color, dimColor, width = "auto", style = {}, onClick, active }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        border: `1px solid ${active ? color : (hovered ? color + "88" : color + "44")}`,
        borderRadius: "7px",
        background: active ? dimColor + "CC" : (hovered ? dimColor + "AA" : dimColor + "66"),
        padding: "8px 12px",
        width,
        cursor: onClick ? "pointer" : "default",
        transition: "all 0.15s",
        transform: hovered && onClick ? "translateY(-1px)" : "none",
        boxShadow: active ? `0 0 12px ${color}33` : "none",
        ...style,
      }}
    >
      <div style={{ fontSize: "12px", fontWeight: 600, color: active || hovered ? color : COLORS.white }}>
        {label}
      </div>
      {sublabel && (
        <div style={{ fontSize: "10px", color: COLORS.dimText, marginTop: "2px" }}>{sublabel}</div>
      )}
    </div>
  );
}

function Arrow({ label, color = COLORS.dimText, vertical = false, reverse = false, style = {} }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexDirection: vertical ? "column" : "row",
      gap: "4px",
      padding: vertical ? "4px 0" : "0 4px",
      ...style,
    }}>
      {reverse && <div style={{ fontSize: "14px", color }}>
        {vertical ? "▲" : "◀"}
      </div>}
      <div style={{ fontSize: "10px", color, letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{label}</div>
      {!reverse && <div style={{ fontSize: "14px", color }}>
        {vertical ? "▼" : "▶"}
      </div>}
    </div>
  );
}

function ConnectionLine({ label, color, dashed = false }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "6px",
      margin: "6px 0",
    }}>
      <div style={{
        flex: 1,
        height: "1px",
        background: dashed
          ? `repeating-linear-gradient(90deg, ${color} 0px, ${color} 6px, transparent 6px, transparent 12px)`
          : color,
      }} />
      <span style={{ fontSize: "10px", color, whiteSpace: "nowrap" }}>{label}</span>
      <div style={{
        flex: 1,
        height: "1px",
        background: dashed
          ? `repeating-linear-gradient(90deg, ${color} 0px, ${color} 6px, transparent 6px, transparent 12px)`
          : color,
      }} />
    </div>
  );
}

function Badge({ text, color }) {
  return (
    <span style={{
      fontSize: "9px",
      background: color + "22",
      border: `1px solid ${color}55`,
      color,
      padding: "1px 5px",
      borderRadius: "3px",
      letterSpacing: "0.06em",
      fontWeight: 600,
    }}>
      {text}
    </span>
  );
}

function InfoPanel({ node, onClose }) {
  if (!node) return null;
  return (
    <div style={{
      position: "fixed",
      top: "50%",
      right: "24px",
      transform: "translateY(-50%)",
      width: "280px",
      background: COLORS.surface,
      border: `1px solid ${node.color}55`,
      borderRadius: "10px",
      padding: "16px",
      zIndex: 100,
      boxShadow: `0 8px 32px ${node.color}22`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: node.color }}>{node.label}</div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.dimText, cursor: "pointer", fontSize: "16px" }}>×</button>
      </div>
      {node.details.map((d, i) => (
        <div key={i} style={{ marginBottom: "10px" }}>
          <div style={{ fontSize: "10px", color: COLORS.dimText, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "3px" }}>{d.key}</div>
          <div style={{ fontSize: "11px", color: COLORS.white, lineHeight: 1.5 }}>{d.val}</div>
        </div>
      ))}
    </div>
  );
}

const nodeData = {
  telegram: {
    label: "Telegram Bot",
    color: COLORS.blue,
    details: [
      { key: "库", val: "grammY v2.x（TypeScript，18k stars，生产可用）" },
      { key: "接入方式", val: "Long Polling（开发）→ Webhook HTTPS（生产）" },
      { key: "协议", val: "Telegram Bot API → InboundUIEvent（JSON）" },
      { key: "成熟度", val: "★★★★★ 高，已有大量生产案例" },
    ],
  },
  hub: {
    label: "Calling Hub Core",
    color: COLORS.amber,
    details: [
      { key: "语言", val: "TypeScript / Node.js 22 LTS" },
      { key: "职责", val: "标准化 → 路由 → 分发 → 回传" },
      { key: "内部通信", val: "Unix Domain Socket（IPC）— 不走 TCP，避免网络栈开销" },
      { key: "日志", val: "Pino 结构化日志，携带 trace_id" },
      { key: "数据验证", val: "Zod schema for HubMessage / HubResult" },
    ],
  },
  instance: {
    label: "实例管理器",
    color: COLORS.amber,
    details: [
      { key: "职责", val: "管理所有 agentapi 子进程的生命周期" },
      { key: "操作", val: "spawn / kill / attach / status / list" },
      { key: "模式切换", val: "Bridge 模式：纯后台 pty；Pane Bridge 模式：pty attach 到 tmux pane" },
      { key: "状态存储", val: "内存 Map<thread_id, AgentInstance>，含 pid、端口、模式、状态" },
    ],
  },
  monitor: {
    label: "Monitor（监测层）",
    color: COLORS.teal,
    details: [
      { key: "独立性", val: "独立模块，通过 IPC 与 Hub 通信，不耦合进主流程" },
      { key: "Heartbeat 模式", val: "轮询 GET /status，检测到 running→stable 时通过 IPC 通知 Hub" },
      { key: "Hook 模式", val: "agentapi SSE 事件流 (GET /events) — 持久连接，实时推送" },
      { key: "适用", val: "两种模式均可配置，per-instance 独立监测" },
    ],
  },
  agentapi: {
    label: "agentapi",
    color: COLORS.green,
    details: [
      { key: "仓库", val: "github.com/coder/agentapi" },
      { key: "语言", val: "Go binary（独立进程）" },
      { key: "版本", val: "v0.11.2，243 commits，MIT 许可，活跃维护" },
      { key: "接口", val: "POST /message · GET /status · GET /events (SSE)" },
      { key: "连接方式", val: "Hub 通过 Unix socket IPC 调用（HTTP over Unix socket）" },
      { key: "Bridge 模式", val: "后台 pty，无界面，完全程序化" },
      { key: "Pane Bridge 模式", val: "pty attach 到 tmux session，操作者可旁观/介入" },
      { key: "成熟度", val: "★★★★☆ 可用，v0.x 中，边缘情况仍在完善" },
    ],
  },
  claude: {
    label: "Claude Code CLI",
    color: COLORS.purple,
    details: [
      { key: "控制方式", val: "agentapi 包装（推荐）或 @anthropic-ai/claude-code SDK（原生）" },
      { key: "认证", val: "ANTHROPIC_API_KEY 环境变量" },
      { key: "特性", val: "--allowedTools 参数可限制执行范围（安全隔离）" },
      { key: "两种模式", val: "Bridge: 后台运行；Pane Bridge: tmux pane 可视" },
    ],
  },
  codex: {
    label: "Codex CLI",
    color: COLORS.purple,
    details: [
      { key: "控制方式", val: "agentapi 包装 或 @openai/codex-sdk（官方 TypeScript SDK）" },
      { key: "认证", val: "ChatGPT 账号 或 OpenAI API Key" },
      { key: "SDK 特性", val: "startThread() + run() 多轮调用，支持会话持久化" },
      { key: "成熟度", val: "★★★★★ SDK 稳定，已 GA" },
    ],
  },
  gemini: {
    label: "Gemini CLI",
    color: COLORS.purple,
    details: [
      { key: "控制方式", val: "agentapi 包装（--type=gemini）" },
      { key: "认证", val: "需宿主机预先完成 gcloud auth 或 gemini auth" },
      { key: "优势", val: "1M token 上下文，适合大型代码库分析" },
      { key: "成熟度", val: "★★★★☆ agentapi 支持稳定，CLI 本身活跃" },
    ],
  },
  cursor: {
    label: "Cursor CLI",
    color: COLORS.purple,
    details: [
      { key: "控制方式", val: "agentapi 包装（headless）或 cursor-agent --print" },
      { key: "认证", val: "CURSOR_API_KEY（从 cursor.com/dashboard 获取）" },
      { key: "注意", val: "--print 模式偶发无限挂起，建议先用 agentapi 包装验证" },
      { key: "成熟度", val: "★★★☆☆ 中，headless 仍有粗糙边缘" },
    ],
  },
};

export default function App() {
  const [activeNode, setActiveNode] = useState(null);

  const toggle = (key) => setActiveNode(prev => prev?.label === nodeData[key].label ? null : nodeData[key]);

  return (
    <div style={styles.root}>
      <div style={styles.title}>CALLING HUB · PHASE 0  —  架构示意图</div>
      <div style={styles.subtitle}>点击任意组件查看详情 · IPC = Unix Domain Socket · HTTPS = 对外网络</div>

      {/* Legend */}
      <div style={styles.legend}>
        {[
          { color: COLORS.blue, label: "Interface Layer（渠道接入）" },
          { color: COLORS.amber, label: "Hub 核心" },
          { color: COLORS.teal, label: "Monitor（独立监测）" },
          { color: COLORS.green, label: "agentapi（Go binary）" },
          { color: COLORS.purple, label: "Coding Agent（CLI 模式）" },
        ].map(l => (
          <div key={l.label} style={styles.legendItem}>
            <div style={styles.legendDot(l.color)} />
            <span>{l.label}</span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: "12px", maxWidth: "900px" }}>
        {/* === MAIN FLOW COLUMN === */}
        <div style={{ flex: 1 }}>

          {/* EXTERNAL */}
          <Layer label="外部世界" color={COLORS.blue} dimColor={COLORS.blueDim + "44"}>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <Box label="操作者 Telegram" sublabel="手机 / 桌面客户端" color={COLORS.blue} dimColor={COLORS.blueDim} onClick={() => toggle("telegram")} active={activeNode?.label === nodeData.telegram.label} />
              <Box label="未来渠道" sublabel="Email / Nostr / WhatsApp" color={COLORS.blue} dimColor={COLORS.blueDim} style={{ opacity: 0.5 }} />
            </div>
          </Layer>

          <Arrow label="HTTPS · Telegram Bot API" color={COLORS.blue} style={{ margin: "4px 0" }} vertical />

          {/* INTERFACE LAYER */}
          <Layer label="[1] Interface Layer" sublabel="渠道适配 — 只收发，不做业务判断" color={COLORS.blue} dimColor={COLORS.blueDim + "33"}>
            <Box
              label="grammY Bot（TypeScript）"
              sublabel="InboundUIEvent 标准化输出 · Long Polling / Webhook"
              color={COLORS.blue}
              dimColor={COLORS.blueDim}
              onClick={() => toggle("telegram")}
              active={activeNode?.label === nodeData.telegram.label}
              style={{ width: "100%" }}
            />
          </Layer>

          <Arrow label="IPC · Unix Domain Socket · HubMessage{JSON}" color={COLORS.amber} style={{ margin: "4px 0" }} vertical />

          {/* HUB CORE */}
          <Layer label="[2] Calling Hub Core  ·  唯一控制平面" color={COLORS.amber} dimColor={COLORS.amberDim + "55"}>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <Box label="标准化" sublabel="InboundUIEvent → HubMessage" color={COLORS.amber} dimColor={COLORS.amberDim} style={{ flex: 1 }} onClick={() => toggle("hub")} active={activeNode?.label === nodeData.hub.label} />
              <Box label="路由" sublabel="intent + target 分发" color={COLORS.amber} dimColor={COLORS.amberDim} style={{ flex: 1 }} onClick={() => toggle("hub")} active={activeNode?.label === nodeData.hub.label} />
              <Box label="可观测" sublabel="trace_id · Pino 日志" color={COLORS.amber} dimColor={COLORS.amberDim} style={{ flex: 1 }} onClick={() => toggle("hub")} active={activeNode?.label === nodeData.hub.label} />
            </div>
            <Box
              label="实例管理器（Instance Manager）"
              sublabel="spawn · kill · attach · detach · status · list  ·  管理所有 agentapi 子进程生命周期"
              color={COLORS.amber}
              dimColor={COLORS.amberDim}
              onClick={() => toggle("instance")}
              active={activeNode?.label === nodeData.instance.label}
              style={{ width: "100%" }}
            />
          </Layer>

          {/* MONITOR — side note */}
          <div style={{ display: "flex", gap: "8px", margin: "8px 0" }}>
            <div style={{ flex: 1 }}>
              <Arrow label="IPC · Unix socket · HubMessage" color={COLORS.green} vertical style={{ margin: "4px 0" }} />
            </div>
            <div style={{ width: "200px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{
                border: `1px dashed ${COLORS.teal}55`,
                borderRadius: "7px",
                background: COLORS.tealDim + "44",
                padding: "8px 10px",
                textAlign: "center",
                cursor: "pointer",
                width: "100%",
              }} onClick={() => toggle("monitor")}>
                <div style={{ fontSize: "10px", fontWeight: 700, color: COLORS.teal, textTransform: "uppercase", letterSpacing: "0.1em" }}>Monitor 层</div>
                <div style={{ fontSize: "9px", color: COLORS.dimText, margin: "3px 0" }}>独立模块 · 低耦合</div>
                <div style={{ fontSize: "9px", color: COLORS.teal }}>Heartbeat 轮询</div>
                <div style={{ fontSize: "9px", color: COLORS.teal }}>SSE Hook 回调</div>
                <div style={{ fontSize: "9px", color: COLORS.dimText, marginTop: "4px" }}>──→ IPC 通知 Hub</div>
              </div>
            </div>
          </div>

          {/* AGENTAPI LAYER */}
          <Layer label="[3] agentapi 层  ·  github.com/coder/agentapi  ·  Go binary  ·  MIT" color={COLORS.green} dimColor={COLORS.greenDim + "55"}>
            <div style={{ marginBottom: "8px" }}>
              <ConnectionLine label="HTTP over Unix socket (IPC) · POST /message · GET /status · GET /events(SSE)" color={COLORS.green} />
            </div>

            {/* Two modes */}
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <div style={{
                flex: 1,
                border: `1px solid ${COLORS.green}44`,
                borderRadius: "7px",
                background: COLORS.greenDim + "44",
                padding: "8px 10px",
              }}>
                <div style={{ fontSize: "10px", fontWeight: 700, color: COLORS.green, marginBottom: "4px" }}>
                  🔲  Bridge 模式（无界面）
                </div>
                <div style={{ fontSize: "9px", color: COLORS.dimText, lineHeight: 1.5 }}>
                  agentapi server 在后台 pty 运行<br/>
                  操作者不可见终端输出<br/>
                  完全无人值守，自动化场景
                </div>
              </div>
              <div style={{
                flex: 1,
                border: `1px solid ${COLORS.teal}44`,
                borderRadius: "7px",
                background: COLORS.tealDim + "44",
                padding: "8px 10px",
              }}>
                <div style={{ fontSize: "10px", fontWeight: 700, color: COLORS.teal, marginBottom: "4px" }}>
                  🖥️  Pane Bridge 模式（有界面）
                </div>
                <div style={{ fontSize: "9px", color: COLORS.dimText, lineHeight: 1.5 }}>
                  pty attach 到 tmux session pane<br/>
                  Hub 写入，操作者可旁观 / 介入<br/>
                  协议层完全一致，spawn 时选模式
                </div>
              </div>
            </div>

            {/* Per-agent instances */}
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {[
                { key: "claude", label: "agentapi\n:claude", agent: "Claude Code CLI" },
                { key: "codex", label: "agentapi\n:codex", agent: "Codex CLI" },
                { key: "gemini", label: "agentapi\n:gemini", agent: "Gemini CLI" },
                { key: "cursor", label: "agentapi\n:cursor", agent: "Cursor CLI" },
              ].map(a => (
                <div key={a.key} style={{ flex: 1, minWidth: "90px" }}>
                  <Box
                    label={a.label.split('\n')[0]}
                    sublabel={a.label.split('\n')[1]}
                    color={COLORS.green}
                    dimColor={COLORS.greenDim}
                    style={{ width: "100%", marginBottom: "4px", textAlign: "center" }}
                  />
                  <Arrow label="" color={COLORS.green} vertical style={{ height: "16px" }} />
                  <Box
                    label={a.agent}
                    color={COLORS.purple}
                    dimColor={COLORS.purpleDim}
                    style={{ width: "100%", textAlign: "center" }}
                    onClick={() => toggle(a.key)}
                    active={activeNode?.label === nodeData[a.key].label}
                  />
                </div>
              ))}
            </div>
          </Layer>



        </div>
      </div>

      {/* IPC annotation */}
      <div style={{
        maxWidth: "900px",
        marginTop: "16px",
        border: `1px solid ${COLORS.border}`,
        borderRadius: "7px",
        background: COLORS.surfaceHigh,
        padding: "12px 16px",
        display: "flex",
        gap: "24px",
        flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: "10px", fontWeight: 700, color: COLORS.amber, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>内部通信协议（IPC）</div>
          <div style={{ fontSize: "10px", color: COLORS.dimText, lineHeight: 1.6 }}>
            Hub ↔ agentapi：Unix Domain Socket（/tmp/agentapi-{"{"}id{"}"}.sock）<br />
            Hub ↔ Monitor：Unix Domain Socket（/tmp/hub-monitor.sock）<br />
            Hub ↔ 实例管理器：同进程内部调用（无需 IPC）<br />
            比 TCP localhost 快 20-40%，不占用端口，不经过网络栈
          </div>
        </div>
        <div>
          <div style={{ fontSize: "10px", fontWeight: 700, color: COLORS.blue, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>外部通信协议（HTTPS）</div>
          <div style={{ fontSize: "10px", color: COLORS.dimText, lineHeight: 1.6 }}>
            操作者 → Telegram Bot API：HTTPS（Telegram 服务器）<br />
            Telegram Bot API → Hub：Webhook HTTPS 或 Long Polling<br />
            结果回传：Hub → Telegram Bot API → 操作者
          </div>
        </div>
        <div>
          <div style={{ fontSize: "10px", fontWeight: 700, color: COLORS.green, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>agentapi 实际成熟度</div>
          <div style={{ fontSize: "10px", color: COLORS.dimText, lineHeight: 1.6 }}>
            v0.11.2 · 243 commits · MIT · 活跃维护<br />
            ✅ Claude Code / Codex / Gemini：生产可用<br />
            ⚠️  Cursor CLI headless：边缘情况仍在完善
          </div>
        </div>
      </div>

      <div style={{ marginTop: "12px", fontSize: "10px", color: COLORS.dimText, maxWidth: "900px" }}>
        ★ grammY（TypeScript Telegram Bot 库）和 agentapi（Go Agent 控制层）是两个实际有代码可运行的成熟开源项目，其余参考实现仅供思路参考，不作为直接依赖。
      </div>

      {/* Info panel */}
      <InfoPanel node={activeNode} onClose={() => setActiveNode(null)} />
    </div>
  );
}
