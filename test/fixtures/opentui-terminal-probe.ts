import { createProductionOpenTuiRenderer, InteractiveTerminalError } from "@coding-agent/coding";

try {
  const renderer = await createProductionOpenTuiRenderer();
  renderer.destroy();
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
} catch (error) {
  if (error instanceof InteractiveTerminalError) {
    process.stdout.write(`${JSON.stringify({ ready: false, code: error.code })}\n`);
    process.exitCode = 0;
  } else {
    throw error;
  }
}
