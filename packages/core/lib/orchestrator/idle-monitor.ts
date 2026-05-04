/**
 * IdleMonitor — tracks Discord idleness and probes system load to decide
 * whether the local runtime can pick up background tasks without disrupting
 * the user (e.g. mid-game).
 */

export interface IdleSnapshot {
  idleMs: number;
  isIdle: boolean;
  systemLoadAvg: number;
  cpuCount: number;
  /** Normalized load (loadavg / cpuCount); >1 means oversubscribed */
  loadRatio: number;
  gpuBusy: boolean;
}

export interface IdleMonitorOptions {
  idleThresholdMs: number;
  /** When loadRatio exceeds this, the system is "busy" — pause background work */
  busyLoadRatio?: number;
  /** When true, pause whenever GPU is detected as busy */
  pauseWhenGpuBusy?: boolean;
}

export class IdleMonitor {
  private lastActivityMs = Date.now();

  constructor(private options: IdleMonitorOptions) {}

  /** Call on every Discord message / interaction. */
  noteActivity(at: number = Date.now()): void {
    this.lastActivityMs = at;
  }

  getLastActivity(): number {
    return this.lastActivityMs;
  }

  setIdleThresholdMs(ms: number): void {
    this.options.idleThresholdMs = ms;
  }

  async snapshot(): Promise<IdleSnapshot> {
    const idleMs = Date.now() - this.lastActivityMs;
    const isIdle = idleMs >= this.options.idleThresholdMs;
    const { loadAvg, cpuCount } = await readSystemLoad();
    const loadRatio = cpuCount > 0 ? loadAvg / cpuCount : 0;
    const gpuBusy = await readGpuBusy();
    return {
      idleMs,
      isIdle,
      systemLoadAvg: loadAvg,
      cpuCount,
      loadRatio,
      gpuBusy,
    };
  }

  /**
   * Whether it is safe to start a background coding task right now.
   * The user is undisturbed, system has headroom, and GPU is free if required.
   */
  async canRunBackground(): Promise<{ ok: boolean; reason: string; snapshot: IdleSnapshot }> {
    const snapshot = await this.snapshot();
    if (!snapshot.isIdle) {
      return { ok: false, reason: "user-active", snapshot };
    }
    const limit = this.options.busyLoadRatio ?? 0.85;
    if (snapshot.loadRatio > limit) {
      return { ok: false, reason: "system-busy", snapshot };
    }
    if (this.options.pauseWhenGpuBusy && snapshot.gpuBusy) {
      return { ok: false, reason: "gpu-busy", snapshot };
    }
    return { ok: true, reason: "idle-headroom", snapshot };
  }
}

interface SystemLoad {
  loadAvg: number;
  cpuCount: number;
}

async function readSystemLoad(): Promise<SystemLoad> {
  try {
    const os = await import("node:os");
    const [oneMin] = os.loadavg();
    return { loadAvg: oneMin ?? 0, cpuCount: os.cpus()?.length ?? 1 };
  } catch {
    return { loadAvg: 0, cpuCount: 1 };
  }
}

/**
 * Crude GPU-busy probe. On macOS we look at whether any non-Ollama process
 * is heavily using the GPU via `ioreg`. Result is best-effort — returns
 * `false` (safe to proceed) on any error.
 */
async function readGpuBusy(): Promise<boolean> {
  try {
    if (process.platform !== "darwin") return false;
    const proc = Bun.spawn(["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const match = text.match(/"PerformanceStatistics"[^}]*"Device Utilization %"=(\d+)/);
    if (!match) return false;
    return parseInt(match[1], 10) > 60;
  } catch {
    return false;
  }
}
