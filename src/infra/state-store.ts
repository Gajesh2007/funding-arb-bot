/**
 * State Persistence
 *
 * Saves and loads bot state for crash recovery.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import type { OpenPosition, FundingSnapshot } from "../strategy/types.js";

export interface PersistedState {
  positions: OpenPosition[];
  fundingHistory: Record<string, FundingSnapshot[]>;
  lastUpdated: number;
}

export class StateStore {
  constructor(private readonly filePath: string = ".bot-state.json") {}

  save(state: PersistedState): void {
    const data = JSON.stringify({ ...state, lastUpdated: Date.now() }, null, 2);
    writeFileSync(this.filePath, data, "utf-8");
  }

  load(): PersistedState | null {
    if (!existsSync(this.filePath)) return null;

    try {
      const data = readFileSync(this.filePath, "utf-8");
      return JSON.parse(data) as PersistedState;
    } catch (error) {
      console.error("Failed to load state:", error);
      return null;
    }
  }

  clear(): void {
    if (existsSync(this.filePath)) {
      writeFileSync(this.filePath, "{}", "utf-8");
    }
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }
}

