import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createTestRenderer } from "@opentui/core/testing";
import stripAnsi from "strip-ansi";

const enterAlternateScreen = "\u001b[?1049h";
const leaveAlternateScreen = "\u001b[?1049l";

function platformArtifact(): string {
  if (process.platform === "win32" && process.arch === "x64") return "@opentui/core-win32-x64";
  if (process.platform === "win32" && process.arch === "arm64") return "@opentui/core-win32-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "@opentui/core-linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "@opentui/core-linux-arm64";
  throw new Error(`未支持的 OpenTUI native target: ${process.platform}-${process.arch}`);
}

interface PtyProcess {
  readonly process: Bun.Subprocess;
  readonly terminal: Bun.Terminal;
  output(): string;
  waitForText(text: string, timeoutMs?: number): Promise<void>;
}

function spawnPtyFixture(mode: "normal" | "signal" | "fatal"): PtyProcess {
  let output = "";
  const waiters = new Set<() => void>();
  const terminal = new Bun.Terminal({
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    data(_terminal, data) {
      output += Buffer.from(data).toString("utf8");
      for (const waiter of waiters) waiter();
    },
  });
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", "test/fixtures/opentui-pty-lifecycle.ts", mode],
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal,
  });
  return {
    process: child,
    terminal,
    output: () => output,
    waitForText(text, timeoutMs = 10_000) {
      if (stripAnsi(output).includes(text)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`等待 PTY output 超时: ${text}\n${stripAnsi(output)}`));
        }, timeoutMs);
        const check = () => {
          if (!stripAnsi(output).includes(text)) return;
          clearTimeout(timeout);
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
      });
    },
  };
}

async function closePty(fixture: PtyProcess): Promise<void> {
  if (fixture.process.exitCode === null) fixture.process.kill("SIGKILL");
  await fixture.process.exited.catch(() => {});
  fixture.terminal.close();
}

describe("OpenTUI terminal platform evidence", () => {
  it("当前 OS/architecture 的 pinned native artifact 可解析并创建 renderer", async () => {
    const artifact = platformArtifact();
    expect(Bun.resolveSync(artifact, process.cwd())).toContain(
      artifact.split("/").at(-1) ?? artifact,
    );
    const setup = await createTestRenderer({ width: 12, height: 4, useThread: false });
    try {
      await setup.renderOnce();
      expect(setup.renderer.width).toBe(12);
      expect(setup.renderer.height).toBe(4);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("redirected stdin/stdout 在 renderer acquire 前产生 typed diagnostic", () => {
    const result = spawnSync(
      process.execPath,
      ["--no-env-file", "test/fixtures/opentui-terminal-probe.ts"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env } },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(enterAlternateScreen);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ready: false,
      code: "INTERACTIVE_STDIN_NOT_TTY",
    });
  });
});

describe.skipIf(process.platform === "win32")("OpenTUI Bun PTY lifecycle", () => {
  it("normal exit 进入 raw/alternate screen、响应 resize 并恢复 terminal", async () => {
    const fixture = spawnPtyFixture("normal");
    try {
      await fixture.waitForText("DEX_PTY_READY raw=true size=80x24");
      fixture.terminal.resize(100, 30);
      fixture.process.kill("SIGWINCH");
      await fixture.waitForText("DEX_PTY_RESIZED raw=true size=100x30");
      expect(await fixture.process.exited).toBe(0);
      const output = fixture.output();
      expect(output).toContain(enterAlternateScreen);
      expect(output).toContain(leaveAlternateScreen);
      expect(output.indexOf(leaveAlternateScreen)).toBeGreaterThan(
        output.indexOf(enterAlternateScreen),
      );
    } finally {
      await closePty(fixture);
    }
  }, 20_000);

  it("SIGTERM 通过 process lifecycle restore 后使用约定 exit code", async () => {
    const fixture = spawnPtyFixture("signal");
    try {
      await fixture.waitForText("DEX_PTY_READY raw=true");
      fixture.process.kill("SIGTERM");
      expect(await fixture.process.exited).toBe(143);
      expect(fixture.output()).toContain(leaveAlternateScreen);
    } finally {
      await closePty(fixture);
    }
  }, 10_000);

  it("uncaught exception 输出 typed diagnostic、restore 并以 1 退出", async () => {
    const fixture = spawnPtyFixture("fatal");
    try {
      await fixture.waitForText("DEX_PTY_READY raw=true");
      expect(await fixture.process.exited).toBe(1);
      const output = fixture.output();
      expect(stripAnsi(output)).toContain("DEX_PROCESS_DIAGNOSTIC UNCAUGHT_EXCEPTION");
      expect(output).toContain(leaveAlternateScreen);
    } finally {
      await closePty(fixture);
    }
  }, 10_000);
});
