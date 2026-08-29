#!/usr/bin/env -S bun --no-env-file
import { runPrintEntry } from "@coding-agent/coding/print";
import { createDeterministicCodingAgent } from "@coding-agent/coding/testing";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";

const scriptedResponse = process.env.FAST_SCRIPTED_RESPONSE;
if (scriptedResponse === undefined) {
  process.stderr.write("deterministic print entry 需要 FAST_SCRIPTED_RESPONSE。\n");
  process.exitCode = 2;
} else {
  const application = createDeterministicCodingAgent({
    model: new ScriptedModel([
      { outcome: { status: "completed", response: scriptedTextResponse(scriptedResponse) } },
    ]),
  });
  try {
    const result = await runPrintEntry(process.argv.slice(2), {
      agent: application.agent,
      workspace: { root: process.cwd(), fingerprint: "head:abc" },
      io: {
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
      },
    });
    process.exitCode = result.exitCode;
  } finally {
    await application.dispose();
  }
}
