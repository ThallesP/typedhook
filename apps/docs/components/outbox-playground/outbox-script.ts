import { OUTBOX_MAX_ATTEMPTS, outboxBackoffSec } from "./outbox-defaults";
import type { SoundName } from "./outbox-sounds";

export type ScenarioId = "happy" | "flaky" | "down" | "rollback" | "crash";
export type TileId = "code" | "outbox" | "worker" | "subscriber";
export type TileState = "idle" | "busy" | "ok" | "bad" | "gone";
export type WireId = "commit" | "claim" | "deliver";
export type PacketKind = "plain" | "ok" | "bad";
export type LogTone = "plain" | "mute" | "ok" | "bad" | "warn" | "highlight";
export type RowStatus = "none" | "pending" | "delivered" | "dead" | "rolled back";

type Reply = 204 | 503 | "timeout";

export type Step =
  | { type: "tile"; tile: TileId; state: TileState; text: string }
  | { type: "row"; status: RowStatus; failedAttempts: number; nextAttempt: string }
  | { type: "log"; atSec: number; text: string; tone: LogTone }
  | { type: "sleep"; ms: number }
  | { type: "fly"; wire: WireId; isReturn: boolean; kind: PacketKind }
  | { type: "countdown"; sec: number }
  | { type: "sound"; sound: SoundName };

export type LogLine = {
  id: number;
  at: string;
  text: string;
  tone: LogTone;
};

export type PlaygroundView = {
  tiles: Record<TileId, { state: TileState; text: string }>;
  row: { status: RowStatus; failedAttempts: number; nextAttempt: string };
  log: LogLine[];
  nextLogId: number;
};

export const scenarioOrder: ScenarioId[] = ["happy", "flaky", "down", "rollback", "crash"];

export const scenarioLabels: Record<ScenarioId, string> = {
  happy: "Happy path",
  flaky: "Flaky endpoint",
  down: "Endpoint down",
  rollback: "Rollback",
  crash: "Worker crash",
};

const scenarioDescriptions: Record<ScenarioId, string> = {
  happy: "The subscriber answers 204 on the first try.",
  flaky: "The subscriber fails twice (a 503, then a timeout), then recovers.",
  down: "The subscriber is down for good. Watch the backoff grow until the row dies.",
  rollback: "Your transaction fails after send(). The event must not go out.",
  crash: "The worker dies after the POST lands but before complete(row).",
};

export const emptyView: PlaygroundView = {
  tiles: {
    code: { state: "idle", text: "" },
    outbox: { state: "idle", text: "" },
    worker: { state: "idle", text: "" },
    subscriber: { state: "idle", text: "" },
  },
  row: { status: "none", failedAttempts: 0, nextAttempt: "—" },
  log: [],
  nextLogId: 0,
};

export function formatClock(sec: number) {
  if (sec < 60) return `+${sec.toFixed(1)}s`;
  if (sec < 3_600) return `+${Math.floor(sec / 60)}m${padTwo(Math.round(sec % 60))}s`;
  return `+${Math.floor(sec / 3_600)}h${padTwo(Math.floor((sec % 3_600) / 60))}m`;
}

export function formatCountdown(remainingSec: number) {
  if (remainingSec >= 120) return `in ${Math.ceil(remainingSec / 60)}m`;
  return `in ${Math.ceil(remainingSec)}s`;
}

function formatDelay(sec: number) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3_600) return `${sec / 60}m`;
  return `${sec / 3_600}h`;
}

function padTwo(value: number) {
  return String(value).padStart(2, "0");
}

export function applyStep(view: PlaygroundView, step: Step): PlaygroundView {
  if (step.type === "tile") {
    return { ...view, tiles: { ...view.tiles, [step.tile]: { state: step.state, text: step.text } } };
  }
  if (step.type === "row") {
    const { status, failedAttempts, nextAttempt } = step;
    return { ...view, row: { status, failedAttempts, nextAttempt } };
  }
  if (step.type === "log") {
    const line = { id: view.nextLogId, at: formatClock(step.atSec), text: step.text, tone: step.tone };
    return { ...view, log: [...view.log, line].slice(-10), nextLogId: view.nextLogId + 1 };
  }
  return view;
}

export function noteView(text: string): PlaygroundView {
  return applyStep(emptyView, { type: "log", atSec: 0, text, tone: "mute" });
}

export function scenarioNoteView(scenario: ScenarioId) {
  return noteView(`${scenarioDescriptions[scenario]} Press Run.`);
}

class OutboxScript {
  private simSec = 0;
  private failedAttempts = 0;
  private isFastForward = false;

  *happy(): Generator<Step> {
    yield* this.enqueue();
    yield* this.claim();
    yield* this.post(204);
    yield* this.complete();
    yield this.log("one request, nothing to retry", "mute");
  }

  *flaky(): Generator<Step> {
    yield* this.enqueue();
    yield* this.claim();
    yield* this.post(503);
    yield* this.retry(503);
    yield* this.claim();
    yield* this.post("timeout");
    yield* this.retry("timeout");
    yield* this.claim();
    yield* this.post(204);
    yield* this.complete();
    yield this.log(`delivered on attempt 3, ${formatClock(this.simSec).slice(1)} after commit`, "mute");
  }

  *down(): Generator<Step> {
    yield* this.enqueue();
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      if (attempt === 4) {
        yield { type: "sound", sound: "fastForward" };
        yield this.log(`>> fast-forwarding attempts 4 → ${OUTBOX_MAX_ATTEMPTS - 1}`, "mute");
        this.isFastForward = true;
      }
      if (attempt === OUTBOX_MAX_ATTEMPTS) this.isFastForward = false;
      yield* this.claim();
      yield* this.post(503);
      if (attempt < OUTBOX_MAX_ATTEMPTS) yield* this.retry(503);
    }
    this.failedAttempts = OUTBOX_MAX_ATTEMPTS;
    yield { type: "sound", sound: "dead" };
    yield this.tile("outbox", "bad", "dead");
    yield this.tile("worker", "bad", "gave up");
    yield this.row("dead", "never");
    yield this.log(`attempt ${OUTBOX_MAX_ATTEMPTS} failed · row marked dead · onDead() fired`, "bad");
    yield this.log(`${formatClock(this.simSec).slice(1)} of retries, backoff capped at 1h`, "mute");
  }

  *rollback(): Generator<Step> {
    yield this.tile("code", "busy", "BEGIN");
    yield this.log("BEGIN", "mute");
    yield this.sleep(450);
    yield this.log("tx.invoice.create() → inv_1");
    yield this.sleep(400);
    yield this.log('wh.with(tx).send("invoice.paid")', "highlight");
    yield* this.fly("commit");
    yield { type: "sound", sound: "insert" };
    yield this.tile("outbox", "busy", "uncommitted");
    yield this.sleep(500);
    this.simSec += 0.02;
    yield this.log("tx.payment.capture() threw · ROLLBACK", "bad");
    yield { type: "sound", sound: "rollback" };
    yield this.tile("code", "bad", "ROLLBACK");
    yield this.tile("outbox", "gone", "rolled back");
    yield this.row("rolled back", "—");
    yield this.sleep(700);
    this.simSec += 1;
    yield* this.claim(0);
    yield this.tile("worker", "idle", "idle");
    yield this.log("nothing sent: no webhook for an invoice that never existed", "ok");
  }

  *crash(): Generator<Step> {
    yield* this.enqueue();
    yield* this.claim();
    yield { type: "sound", sound: "post" };
    yield this.log("POST hooks.northwind.dev/billing · attempt 1");
    yield this.tile("subscriber", "busy", "…");
    yield* this.fly("deliver");
    yield this.sleep(380);
    this.simSec += 0.12;
    yield { type: "sound", sound: "ok" };
    yield this.tile("subscriber", "ok", "204 OK");
    yield this.sleep(300);
    yield { type: "sound", sound: "crash" };
    yield this.tile("worker", "bad", "SIGKILL");
    yield this.log("worker died before complete(row)", "bad");
    yield this.log("row stays pending, hidden for claimTimeoutMs (60s)", "warn");
    yield this.row("pending", "in 60s");
    yield* this.countdown(60);
    yield* this.claim(1, "worker#2");
    yield* this.post(204, 2);
    yield this.log("same webhook-id evt_3f1c… · subscriber skips the duplicate", "mute");
    yield* this.complete();
  }

  private *enqueue(): Generator<Step> {
    yield this.tile("code", "busy", "BEGIN");
    yield this.log("BEGIN", "mute");
    yield this.sleep(450);
    this.simSec += 0.01;
    yield this.log("tx.invoice.create() → inv_1");
    yield this.sleep(400);
    yield this.log('wh.with(tx).send("invoice.paid")', "highlight");
    yield* this.fly("commit");
    yield { type: "sound", sound: "insert" };
    yield this.tile("outbox", "busy", "writing");
    yield this.sleep(350);
    this.simSec += 0.01;
    yield this.log("COMMIT · outbox row saved with your data", "ok");
    yield this.tile("code", "ok", "COMMIT");
    yield this.tile("outbox", "idle", "pending");
    yield this.row("pending", "now");
    yield this.sleep(550);
  }

  private *claim(rows = 1, worker = "worker"): Generator<Step> {
    this.simSec += 0.4;
    yield this.tile("worker", "busy", "tick()");
    if (!this.isFastForward) {
      yield { type: "sound", sound: "claim" };
      yield this.log(`${worker}.tick() · claim(100) → ${rows} row${rows === 1 ? "" : "s"}`, "mute");
    }
    if (rows > 0) yield* this.fly("claim");
    yield this.sleep(250);
  }

  private *post(reply: Reply, attempt = this.failedAttempts + 1): Generator<Step> {
    const isTimeout = reply === "timeout";
    if (!this.isFastForward) {
      yield { type: "sound", sound: "post" };
      yield this.log(`POST hooks.northwind.dev/billing · attempt ${attempt}`);
    }
    yield this.tile("subscriber", "busy", "…");
    yield* this.fly("deliver");
    yield this.sleep(isTimeout ? 900 : 380);
    this.simSec += isTimeout ? 10 : 0.12;
    if (reply === 204) {
      yield { type: "sound", sound: "ok" };
      yield this.tile("subscriber", "ok", "204 OK");
      yield* this.fly("deliver", "ok");
      return;
    }
    if (!this.isFastForward) yield { type: "sound", sound: "fail" };
    yield this.tile("subscriber", "bad", isTimeout ? "timeout" : String(reply));
    yield* this.fly("deliver", "bad");
  }

  private *retry(reply: Reply): Generator<Step> {
    this.failedAttempts++;
    const delaySec = outboxBackoffSec(this.failedAttempts);
    const failure = reply === "timeout" ? "timed out after 10s" : `responded ${reply}`;
    if (!this.isFastForward) yield this.log(`${failure} · retry in ${formatDelay(delaySec)}`, "warn");
    yield this.tile("worker", "idle", "sleeping");
    yield this.row("pending", `in ${formatDelay(delaySec)}`);
    yield* this.countdown(delaySec);
  }

  private *complete(): Generator<Step> {
    yield this.log("complete(row) · delivered", "ok");
    yield this.tile("outbox", "ok", "delivered");
    yield this.tile("worker", "ok", "done");
    yield this.row("delivered", "—");
  }

  private *countdown(sec: number): Generator<Step> {
    if (this.isFastForward) {
      this.simSec += sec;
      yield this.sleep(60);
      return;
    }
    yield { type: "countdown", sec };
    this.simSec += sec;
  }

  private *fly(wire: WireId, kind?: PacketKind): Generator<Step> {
    if (this.isFastForward) return;
    yield { type: "fly", wire, isReturn: kind !== undefined, kind: kind ?? "plain" };
  }

  private tile(tile: TileId, state: TileState, text: string): Step {
    return { type: "tile", tile, state, text };
  }

  private row(status: RowStatus, nextAttempt: string): Step {
    return { type: "row", status, failedAttempts: this.failedAttempts, nextAttempt };
  }

  private log(text: string, tone: LogTone = "plain"): Step {
    return { type: "log", atSec: this.simSec, text, tone };
  }

  private sleep(ms: number): Step {
    return { type: "sleep", ms: this.isFastForward ? Math.min(ms, 40) : ms };
  }
}

export function scriptFor(scenario: ScenarioId): Generator<Step> {
  return new OutboxScript()[scenario]();
}

export const previewView = [...scriptFor("flaky")].reduce(applyStep, emptyView);
