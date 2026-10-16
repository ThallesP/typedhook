import * as core from "@actions/core";
import { run } from "./main";

// Exits even when the sender's webhooks file left a client or timer holding the event loop open,
// once the output has been written, since process.exit() drops pending pipe writes.
run()
  .catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error : String(error));
  })
  .finally(async () => {
    await flushed(process.stdout);
    await flushed(process.stderr);
    process.exit();
  });

function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.write("", () => resolve()));
}

