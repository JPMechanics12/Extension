import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveIBTRACSPath() {
  if (process.env.IBTRACS_PATH) return process.env.IBTRACS_PATH;
  const base = path.join(__dirname, '../../data');
  const preferred = path.join(base, 'ibtracs1.csv');
  if (fs.existsSync(preferred)) return preferred;
  // fallbacks if needed
  const candidates = ['ibtracs.csv', 'ibtracs.xlsx'];
  for (const c of candidates) {
    const p = path.join(base, c);
    if (fs.existsSync(p)) return p;
  }
  return preferred; // default target even if missing (clear error)
}

export const IBTRACS_PATH = resolveIBTRACSPath();
export const DEFAULT_YEAR = Number(process.env.DEFAULT_YEAR || new Date().getUTCFullYear());
export const UCAR_BASE = 'https://hurricanes.ral.ucar.edu/repository/data/bdecks_open';
