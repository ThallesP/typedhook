import type { FetchImpl } from "@typedhook/verify/registry";
import { type Env, findProject, registryUrl } from "../config";
import { saveCredentials } from "../credentials";
import { registryApi } from "../registry-api";

export type LoginOptions = {
  cwd?: string;
  env?: Env;
  log?: (line: string) => void;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
};

/** `typedhook login`: GitHub's device flow, so it works over SSH and from agents too. */
export async function login({
  cwd = process.cwd(),
  env = process.env,
  log = console.log,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
}: LoginOptions = {}): Promise<void> {
  const url = registryUrl((await findProject(cwd))?.config, env);
  const api = registryApi(url, fetchImpl);
  const { deviceCode, userCode, verificationUri, expiresIn, interval } = await api.startDeviceLogin();
  log(`open ${verificationUri} and enter the code ${userCode}`);
  log("waiting for GitHub...");
  const deadline = Date.now() + expiresIn * 1000;
  let waitSec = interval;
  while (Date.now() < deadline) {
    await sleep(waitSec * 1000);
    const poll = await api.pollDeviceLogin(deviceCode);
    if (poll.status === "pending") {
      waitSec = poll.interval;
      continue;
    }
    await saveCredentials(url, { token: poll.token, login: poll.login }, env);
    log(`signed in as ${poll.login}; you can publish as ${poll.owners.join(", ")}`);
    return;
  }
  throw new Error("the code expired, run `typedhook login` again");
}
