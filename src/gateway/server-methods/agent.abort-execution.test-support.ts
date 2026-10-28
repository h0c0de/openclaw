import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { isAgentRunDirectAbortReason } from "../../agents/run-termination.js";
import {
  getRpcSource,
  getRpcSourceProjectSessionActive,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  requireValue,
  expectRecordFields,
  mockCallArg,
  invokeAgent,
  prime,
} from "./agent.test-harness.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";

const mocks = getAgentTestMocks();
const sessionKey = "agent:main:main";
type Cancellation = { action: "chat.abort" | "/stop"; lateFailure?: boolean; staleKey?: boolean };

async function checkCancellation(cancellation: Cancellation, signal: AbortSignal) {
  const { action, lateFailure, staleKey } = cancellation;
  prime();
  const finishRun = createDeferred();
  const context = makeContext();
  const runId = staleKey ? "idem-abort-stale-session-key" : "idem-abort-run";
  const client = staleKey ? { ...operatorWriteCliClient(), connId: "owner-conn" } : null;
  let acceptedEntry: RpcSourceRef | undefined;
  let capturedSignal: AbortSignal | undefined;
  mocks.agentCommand.mockImplementationOnce(async (opts: { abortSignal?: AbortSignal }) => {
    capturedSignal = opts.abortSignal;
    await finishRun.promise;
    if (lateFailure) {
      throw new Error("late provider failure");
    }
    return {
      payloads: [{ text: "late completion" }],
      meta: { durationMs: 1, terminalReply: { disposition: "visible", text: "late completion" } },
    };
  });
  let abort: Promise<void> | undefined;
  try {
    await invokeAgent(
      { message: "hi", agentId: "main", sessionKey, idempotencyKey: runId },
      { context, reqId: runId, client },
    );
    const active = (acceptedEntry = requireValue(getRpcSource(runId), "active run missing"));
    expect(capturedSignal).toBe(active.input.abortSignal);
    if (staleKey) {
      expect(active.input.target?.sessionKey).toBe(sessionKey);
    } else {
      expect(capturedSignal?.aborted).toBe(false);
    }
    const abortRespond = vi.fn();
    const options = { respond: abortRespond, context, client, isWebchatConnect: () => false };
    abort =
      action === "chat.abort"
        ? handleChatAbortRequest({
            ...options,
            params: { sessionKey: staleKey ? "agent:main:stale-key" : sessionKey, runId },
            req: { type: "req", id: "abort-req", method: "chat.abort" },
          })
        : handleDirectExternalChatSend({
            ...options,
            params: { sessionKey, message: "/stop", idempotencyKey: "idem-late-failure-stop" },
            req: { type: "req", id: "stop-req", method: "chat.send" },
          });
    // Cancellation must acknowledge while the raw producer is still blocked.
    await withinTest(abort, signal);
    expect(capturedSignal?.aborted).toBe(true);
    if (!staleKey) {
      expect(isAgentRunDirectAbortReason(capturedSignal?.reason)).toBe(true);
      expect(active.adapter.abortStopReason).toBe(action === "chat.abort" ? "rpc" : "stop");
    }
    expect(getRpcSourceProjectSessionActive(active)).toBe(false);
    expect(getRpcSource(runId)).toBe(active);
    expect(mockCallArg(abortRespond)).toBe(true);
    expectRecordFields(mockCallArg(abortRespond, 0, 1), { aborted: true, runIds: [runId] });
  } finally {
    finishRun.resolve();
    await Promise.allSettled([abort]);
    await acceptedEntry?.input.settlement.promise;
  }
  expect(getRpcSource(runId)).toBeUndefined();
  if (lateFailure) {
    const terminal = context.dedupe.get(`agent:${runId}`);
    expect([terminal?.ok, terminal?.error]).toEqual([true, undefined]);
    expectRecordFields(terminal?.payload, { runId, status: "timeout", summary: "aborted" });
  }
}

export function registerAgentAbortRunExecutionTest() {
  it.for([
    { action: "chat.abort", lateFailure: false },
    { action: "chat.abort", lateFailure: true },
    { action: "/stop", lateFailure: true },
  ] as const)("settles $action (late failure: $lateFailure)", (testCase, { signal }) =>
    checkCancellation(testCase, signal),
  );
}

export function registerAgentAbortStaleKeyExecutionTest() {
  it("chat.abort by runId allows the owner connection to use a stale session key", ({ signal }) =>
    checkCancellation({ action: "chat.abort", staleKey: true }, signal));
}

export function registerAgentElapsedQueueDeadlineTest(
  captureAgentRunSettlement: (runId: string) => Promise<void>,
) {
  it("keeps an elapsed queue deadline terminal before the maintenance sweep", async () => {
    prime();
    const runId = "idem-agent-expired-queue-deadline";
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(0);
    const agentResult = createDeferred<{ payloads: []; meta: { durationMs: number } }>();
    let settlement: Promise<void> | undefined;
    let onExecutionStarted: (() => void | Promise<void>) | undefined;
    mocks.agentCommand.mockImplementation(
      (opts: { onExecutionStarted?: () => void | Promise<void> }) => {
        onExecutionStarted = opts.onExecutionStarted;
        return agentResult.promise;
      },
    );
    const context = makeContext();

    try {
      await invokeAgent(
        {
          message: "do not revive an expired queue deadline",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
          timeout: 120,
        },
        { context, respond: vi.fn(), reqId: runId },
      );

      const abortEntry = requireValue(getRpcSource(runId), "chat abort entry missing");
      settlement = captureAgentRunSettlement(runId);
      const timing = requireValue(abortEntry.adapter.timing, "source timing missing");
      const startedAtMs = timing.queuedAtMs;
      const queueExpiresAtMs = timing.expiresAtMs;
      nowMs = queueExpiresAtMs + 1;
      monotonic.mockReturnValue(120_001);
      const executionStarted = requireValue(onExecutionStarted, "execution-start callback missing");
      await executionStarted();

      expect(timing.queuedAtMs).toBe(startedAtMs);
      expect(timing.expiresAtMs).toBe(queueExpiresAtMs);
      expect(abortEntry.input.abortSignal.aborted).toBe(true);
      expect(abortEntry.adapter.abortStopReason).toBe("timeout");

      nowMs = queueExpiresAtMs - 1;
      await executionStarted();
      expect(timing.expiresAtMs).toBe(queueExpiresAtMs);
    } finally {
      const remaining = captureAgentRunSettlement(runId);
      agentResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      await settlement;
      await remaining;
      dateNow.mockRestore();
      monotonic.mockRestore();
    }
  });
}
