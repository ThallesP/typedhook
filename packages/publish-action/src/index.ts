import * as core from "@actions/core";
import { run } from "./main";

// Exits even when the sender's webhooks file left a client or timer holding the event loop open.
run()
  .catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error : String(error));
  })
  .finally(() => process.exit());
