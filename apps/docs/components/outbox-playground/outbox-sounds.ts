type Tone = {
  fromHz: number;
  toHz?: number;
  durationSec: number;
  wave?: OscillatorType;
  volume?: number;
  delaySec?: number;
};

export type SoundName =
  | "insert"
  | "claim"
  | "post"
  | "ok"
  | "fail"
  | "tick"
  | "dead"
  | "rollback"
  | "crash"
  | "fastForward"
  | "toggle";

const sounds: Record<SoundName, Tone[]> = {
  insert: [
    { fromHz: 1046, durationSec: 0.07 },
    { fromHz: 1568, durationSec: 0.09, volume: 0.04, delaySec: 0.05 },
  ],
  claim: [{ fromHz: 660, durationSec: 0.06, wave: "triangle" }],
  post: [{ fromHz: 420, toHz: 880, durationSec: 0.13, volume: 0.035 }],
  ok: [
    { fromHz: 1318.5, durationSec: 0.2 },
    { fromHz: 1975.5, durationSec: 0.32, volume: 0.045, delaySec: 0.1 },
  ],
  fail: [{ fromHz: 220, toHz: 165, durationSec: 0.16, wave: "square", volume: 0.022 }],
  tick: [{ fromHz: 2400, durationSec: 0.015, volume: 0.012 }],
  dead: [{ fromHz: 330, toHz: 82, durationSec: 0.6, wave: "sawtooth", volume: 0.025 }],
  rollback: [{ fromHz: 880, toHz: 220, durationSec: 0.3, wave: "triangle", volume: 0.04 }],
  crash: [
    { fromHz: 140, toHz: 55, durationSec: 0.35, wave: "square", volume: 0.035 },
    { fromHz: 90, toHz: 40, durationSec: 0.4, wave: "sawtooth", volume: 0.02, delaySec: 0.05 },
  ],
  fastForward: [{ fromHz: 500, toHz: 1400, durationSec: 0.25, volume: 0.02 }],
  toggle: [{ fromHz: 1318, durationSec: 0.12 }],
};

let audioContext: AudioContext | undefined;

export function playSound(name: SoundName) {
  audioContext ??= new AudioContext();
  if (audioContext.state === "suspended") void audioContext.resume();
  for (const tone of sounds[name]) playTone(audioContext, tone);
}

function playTone(
  context: AudioContext,
  { fromHz, toHz, durationSec, wave = "sine", volume = 0.05, delaySec = 0 }: Tone,
) {
  const startSec = context.currentTime + delaySec;
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(fromHz, startSec);
  if (toHz) oscillator.frequency.exponentialRampToValueAtTime(toHz, startSec + durationSec);
  gain.gain.setValueAtTime(0.0001, startSec);
  gain.gain.exponentialRampToValueAtTime(volume, startSec + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startSec + durationSec);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startSec);
  oscillator.stop(startSec + durationSec + 0.03);
}
