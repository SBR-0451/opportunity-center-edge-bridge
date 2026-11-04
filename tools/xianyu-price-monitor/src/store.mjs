import fs from 'node:fs';
import path from 'node:path';

const HISTORY_HEADER = ['time', 'task', 'itemId', 'price', 'status', 'title', 'area', 'seller', 'url'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 状态（data/state.json）+ 价格变化历史（data/history.csv，带 BOM，Excel 可直接打开） */
export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    this.historyPath = path.join(dataDir, 'history.csv');
    fs.mkdirSync(dataDir, { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.statePath)) return { tasks: {}, system: {} };
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      return { tasks: {}, system: {}, ...state };
    } catch (e) {
      const backup = `${this.statePath}.broken-${Date.now()}`;
      fs.renameSync(this.statePath, backup);
      console.warn(`state.json 损坏，已备份到 ${backup} 并重新开始：${e.message}`);
      return { tasks: {}, system: {} };
    }
  }

  save(state) {
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  appendHistory(rows) {
    if (!rows.length) return;
    const fresh = !fs.existsSync(this.historyPath);
    const lines = rows.map((r) => HISTORY_HEADER.map((k) => csvCell(r[k])).join(','));
    const head = fresh ? `﻿${HISTORY_HEADER.join(',')}\n` : '';
    fs.appendFileSync(this.historyPath, `${head}${lines.join('\n')}\n`);
  }
}
