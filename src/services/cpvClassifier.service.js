import { fetchClassifier } from '../libs/adapters/source/gnumner/client.js';
import { fileDate, parseClassifier } from '../libs/adapters/source/gnumner/classifier.parser.js';
import cpvClassifier from '../repositories/cpvClassifier.repo.js';
import tenders from '../repositories/tender.repo.js';

/**
 * The CPV classifier: Armenia's official list of procurement codes and their
 * Armenian names, the closed set every inferred code is chosen from (ADR 0006,
 * cpv-inference ticket 01). Refreshed by hand — `npm run cpv:refresh` — so the
 * owner sees what a new ministry file changes before it is written.
 */

/**
 * The full list, plus the e-auction subset's codes it lacks, marked as such.
 * Where both name a code the full list's name wins: the subset is an older,
 * smaller copy, and the 47 names in which they differ (2026-11) are spelling
 * fixes made to the full list.
 */
export const mergeSubset = (full, subset) => {
  const known = new Set(full.map((e) => e.code));
  return [
    ...full.map((e) => ({ ...e, eauctionOnly: false })),
    ...subset.filter((e) => !known.has(e.code)).map((e) => ({ ...e, eauctionOnly: true })),
  ];
};

/**
 * What writing `incoming` would change in `stored`. `withdrawn` is the
 * ticket's "removed": a code the file no longer lists, which is marked and
 * never deleted, because an inferred code must keep resolving to its name.
 * `restored` is a withdrawn code listed again.
 */
export const diff = (stored, incoming) => {
  const before = new Map(stored.map((r) => [r.code, r]));
  const after = new Map(incoming.map((e) => [e.code, e]));
  const changes = { added: [], withdrawn: [], restored: [], renamed: [], unitChanged: [], subsetChanged: [] };

  for (const e of incoming) {
    const old = before.get(e.code);
    if (!old) {
      changes.added.push(e);
      continue;
    }
    if (old.withdrawn_in) changes.restored.push(e);
    if (old.name !== e.name) changes.renamed.push({ code: e.code, from: old.name, to: e.name });
    if ((old.unit ?? null) !== (e.unit ?? null)) changes.unitChanged.push({ code: e.code, from: old.unit, to: e.unit });
    if (old.eauction_only !== e.eauctionOnly) changes.subsetChanged.push({ code: e.code, eauctionOnly: e.eauctionOnly });
  }
  for (const r of stored) if (!r.withdrawn_in && !after.has(r.code)) changes.withdrawn.push(r);
  return changes;
};

export const isUnchanged = (changes) => Object.values(changes).every((list) => !list.length);

/** A Last-Modified header as the Yerevan calendar day, the ministry's. */
const yerevanDay = (httpDate) => {
  const d = httpDate ? new Date(httpDate) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yerevan' }).format(d);
};

/** The latest version stored, from the rows the file still lists. */
const storedVersion = (stored) =>
  stored.reduce((max, r) => (!r.withdrawn_in && (!max || r.version > max) ? r.version : max), null);

export default class CpvClassifierService {
  /**
   * Download both files, read them and compare them with what is stored.
   * Writes nothing. The version is the date the full list's name states, or
   * failing that its Last-Modified day; with neither there is no version to
   * record, and the refresh stops.
   */
  static async plan() {
    const files = await fetchClassifier();
    const full = parseClassifier(files.full.bytes);
    const subset = parseClassifier(files.eauction.bytes);

    const version = fileDate(files.full.path) ?? yerevanDay(files.full.lastModified);
    if (!version) throw new Error(`[cpv-classifier] ${files.full.path} states no date and was served without Last-Modified`);

    const entries = mergeSubset(full.entries, subset.entries);
    const stored = await cpvClassifier.listAll();
    const changes = diff(stored, entries);

    // Coverage against the file, not the table, so a dry run already says it.
    const incoming = new Set(entries.map((e) => e.code));
    const stated = await tenders.distinctStatedCpvCodes();
    const unnamed = stated.filter((s) => !incoming.has(s.code));

    return {
      files,
      version,
      storedVersion: storedVersion(stored),
      full,
      subset,
      entries,
      changes,
      unchanged: isUnchanged(changes),
      statedCodes: stated.length,
      unnamed,
    };
  }

  /**
   * Write a plan, in one transaction. Refuses a file older than the stored
   * version: applying it would withdraw every code added since.
   */
  static async apply(plan) {
    if (plan.storedVersion && plan.version < plan.storedVersion) {
      throw new Error(`[cpv-classifier] file version ${plan.version} is older than the stored ${plan.storedVersion}`);
    }
    return cpvClassifier.replace(plan.entries, plan.version);
  }
}
