"use client";

import { CodeXml, Cog, Database, type LucideIcon, Play, Server, Square } from "lucide-react";
import { type Ref, useEffect, useRef, useState } from "react";
import { OUTBOX_MAX_ATTEMPTS } from "./outbox-defaults";
import styles from "./outbox-playground.module.css";
import {
  emptyView,
  noteView,
  previewView,
  type RowStatus,
  type ScenarioId,
  scenarioLabels,
  scenarioNoteView,
  scenarioOrder,
  scriptFor,
  type TileState,
  type WireId,
} from "./outbox-script";
import { playSound } from "./outbox-sounds";
import { ScriptPlayer } from "./script-player";

const statusText: Record<RowStatus, string> = {
  none: "—",
  pending: "pending",
  delivered: "delivered",
  dead: "dead",
  "rolled back": "rolled back",
};

export function OutboxPlayground() {
  const [scenario, setScenario] = useState<ScenarioId>("flaky");
  const [view, setView] = useState(previewView);
  const [isRunning, setIsRunning] = useState(false);
  const [isSoundOn, setIsSoundOn] = useState(true);
  const playerRef = useRef<ScriptPlayer | null>(null);
  const isSoundOnRef = useRef(true);
  const packetsRef = useRef<Record<WireId, HTMLSpanElement | null>>({ commit: null, claim: null, deliver: null });

  useEffect(() => () => playerRef.current?.stop(), []);

  async function handleRun() {
    playerRef.current?.stop();
    if (isRunning) {
      playerRef.current = null;
      setIsRunning(false);
      setView(noteView("stopped"));
      return;
    }

    const player = new ScriptPlayer({
      setView,
      packets: packetsRef.current,
      isSoundOn: () => isSoundOnRef.current,
    });
    playerRef.current = player;
    setIsRunning(true);
    setView(emptyView);
    await player.play(scriptFor(scenario));
    if (playerRef.current !== player) return;
    playerRef.current = null;
    setIsRunning(false);
  }

  function handleSelectScenario(nextScenario: ScenarioId) {
    playerRef.current?.stop();
    playerRef.current = null;
    setScenario(nextScenario);
    setIsRunning(false);
    setView(scenarioNoteView(nextScenario));
  }

  function handleToggleSound() {
    const isNowOn = !isSoundOn;
    isSoundOnRef.current = isNowOn;
    setIsSoundOn(isNowOn);
    if (isNowOn) playSound("toggle");
  }

  return (
    <div className={`not-prose ${styles.playground}`}>
      <div className={styles.head}>
        <span className={styles.headIcon}>
          <Play />
        </span>
        <div className={styles.title}>
          <b>Outbox playground</b>
          <span>Pick what goes wrong, press Run, and watch the outbox deal with it.</span>
        </div>
        <button
          type="button"
          aria-pressed={isSoundOn}
          data-on={isSoundOn}
          onClick={handleToggleSound}
          className={styles.soundSwitch}
        >
          <i />
          {isSoundOn ? "Sound on" : "Sound off"}
        </button>
      </div>

      <div className={styles.scenarios}>
        <small>Scenario</small>
        {scenarioOrder.map((id) => (
          <button key={id} type="button" data-active={id === scenario} onClick={() => handleSelectScenario(id)}>
            {scenarioLabels[id]}
          </button>
        ))}
      </div>

      <div className={styles.stage}>
        <Tile icon={CodeXml} label="your code" {...view.tiles.code} />
        <Wire packetRef={(packet) => { packetsRef.current.commit = packet; }} />
        <Tile icon={Database} label="outbox" {...view.tiles.outbox} />
        <Wire packetRef={(packet) => { packetsRef.current.claim = packet; }} />
        <Tile icon={Cog} label="worker" {...view.tiles.worker} />
        <Wire packetRef={(packet) => { packetsRef.current.deliver = packet; }} />
        <Tile icon={Server} label="subscriber" {...view.tiles.subscriber} />
      </div>

      <div className={styles.row}>
        <div>
          <small>Row</small>
          <b>obx_7c1e…</b>
        </div>
        <div>
          <small>Status</small>
          <b data-status={view.row.status}>{statusText[view.row.status]}</b>
        </div>
        <div>
          <small>Failed attempts</small>
          <b>
            {view.row.failedAttempts} / {OUTBOX_MAX_ATTEMPTS}
          </b>
        </div>
        <div>
          <small>Next attempt</small>
          <b>{view.row.nextAttempt}</b>
        </div>
      </div>

      <div className={styles.log} role="log" aria-live="polite">
        {view.log.map((line) => (
          <p key={line.id}>
            <span className={styles.time}>{line.at}</span>
            <span data-tone={line.tone}>{line.text}</span>
          </p>
        ))}
      </div>

      <div className={styles.foot}>
        <button type="button" data-running={isRunning} onClick={handleRun} className={styles.run}>
          {isRunning ? <Square /> : <Play />}
          {isRunning ? "Stop" : "Run"}
        </button>
        <span className={styles.hint}>1s here ≈ 30s of real time</span>
        <code>outbox(adapter, {`{ maxAttempts: ${OUTBOX_MAX_ATTEMPTS} }`})</code>
      </div>
    </div>
  );
}

type TileProps = {
  icon: LucideIcon;
  label: string;
  state: TileState;
  text: string;
};

function Tile({ icon: Icon, label, state, text }: TileProps) {
  return (
    <div className={styles.tile} data-state={state}>
      <div className={styles.square}>
        <Icon />
      </div>
      <div className={styles.label}>{label}</div>
      <div className={styles.status}>{text}</div>
    </div>
  );
}

type WireProps = {
  packetRef: Ref<HTMLSpanElement>;
};

function Wire({ packetRef }: WireProps) {
  return (
    <div className={styles.wire}>
      <span ref={packetRef} className={styles.packet} />
    </div>
  );
}
