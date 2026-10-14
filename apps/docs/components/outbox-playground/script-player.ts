import type { Dispatch, SetStateAction } from "react";
import {
  applyStep,
  formatCountdown,
  type PacketKind,
  type PlaygroundView,
  type Step,
  type WireId,
} from "./outbox-script";
import { playSound, type SoundName } from "./outbox-sounds";

export type ScriptPlayerOptions = {
  setView: Dispatch<SetStateAction<PlaygroundView>>;
  packets: Record<WireId, HTMLSpanElement | null>;
  isSoundOn: () => boolean;
};

export class ScriptPlayer {
  private isStopped = false;

  constructor(private readonly options: ScriptPlayerOptions) {}

  stop() {
    this.isStopped = true;
  }

  async play(script: Iterable<Step>) {
    for (const step of script) {
      if (this.isStopped) return;
      await this.perform(step);
    }
  }

  private async perform(step: Step) {
    if (step.type === "sleep") return this.sleep(step.ms);
    if (step.type === "fly") return this.fly(step.wire, step.isReturn, step.kind);
    if (step.type === "countdown") return this.countdown(step.sec);
    if (step.type === "sound") return this.sound(step.sound);
    this.options.setView((view) => applyStep(view, step));
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async fly(wire: WireId, isReturn: boolean, kind: PacketKind) {
    const packet = this.options.packets[wire];
    if (!packet) return;
    packet.dataset.kind = kind;
    const [from, to] = isReturn ? ["100%", "0%"] : ["0%", "100%"];
    await packet.animate(
      [
        { left: from, opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { opacity: 1, offset: 0.85 },
        { left: to, opacity: 0 },
      ],
      { duration: 420, easing: "cubic-bezier(.45,0,.2,1)" },
    ).finished;
  }

  private countdown(sec: number) {
    const durationMs = Math.min(2_600, Math.max(700, (sec * 1_000) / 30));
    const startedAt = performance.now();
    let lastTickAt = 0;

    return new Promise<void>((resolve) => {
      const frame = (now: number) => {
        if (this.isStopped) return resolve();
        const progress = Math.min(1, (now - startedAt) / durationMs);
        const nextAttempt = formatCountdown(sec * (1 - progress));
        this.options.setView((view) => ({ ...view, row: { ...view.row, nextAttempt } }));
        if (now - lastTickAt > 220) {
          lastTickAt = now;
          this.sound("tick");
        }
        if (progress === 1) return resolve();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  private sound(name: SoundName) {
    if (this.options.isSoundOn()) playSound(name);
  }
}
