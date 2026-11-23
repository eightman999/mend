// main.ts is mend, the CLI SPEC.md specifies: `node main.ts [options] [PATCH]` applies an edit an AI model
// wrote — a unified diff, SEARCH/REPLACE blocks, a V4A patch or JSON tool calls — to the tree of text files in
// the working directory, all or nothing. Node 22, the standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- section 3: a file's lines, break and final break ----------

interface FileText {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const i = text.indexOf('\n');
  const br = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const lines = text.split(br);
  if (fin) lines.pop();
  return { lines, br, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (fin ? br : '');
}

// ---------- section 5: matching lines at three tiers ----------

const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];
const eqTier = (a: string, b: string, tier: number): boolean =>
  tier === 0 ? a === b : tier === 1 ? a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '') : a.replace(/^[ \t]+|[ \t]+$/g, '') === b.replace(/^[ \t]+|[ \t]+$/g, '');

/** Every position at or after `from` where o occurs in lines at `tier` (`endOnly`: only one that ends at the last line). */
function occAt(lines: string[], o: string[], tier: number, from: number, endOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    if (endOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!eqTier(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  pos: number[];
}

/** O's positions at the first tier where it occurs, or null when it occurs at none. */
function findO(lines: string[], o: string[], strict: boolean, from = 0, endOnly = false): Found | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const pos = occAt(lines, o, tier, from, endOnly);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** A tier-2 re-indent: the leading whitespace P of O's first line swapped for the file's own F. */
function reindent(s: string, F: string, P: string): string {
  return s !== '' && s.trim() !== '' && s.startsWith(P) ? F + s.slice(P.length) : s;
}

// One line of a hunk body or a V4A chunk body.
interface BodyLine {
  k: 'ctx' | 'old' | 'new' | 'bs';
  s: string;
}

/** The O or N length of a body. */
function countBody(body: BodyLine[], which: 'o' | 'n'): number {
  let n = 0;
  for (const e of body) {
    if (which === 'o' ? e.k === 'ctx' || e.k === 'old' : e.k === 'ctx' || e.k === 'new') n += 1;
  }
  return n;
}

/**
 * The lines a matched body writes: context lines are the file's own matched lines, `+` lines are the
 * patch's, re-indented at tier 2. `fl` and `pos` are the file's lines and the match position.
 */
function writtenN(body: BodyLine[], fl: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const F = leadWS(fl[pos]!);
  let P = '';
  for (const e of body) {
    if (e.k === 'ctx' || e.k === 'old') {
      P = leadWS(e.s);
      break;
    }
  }
  let oi = 0;
  for (const e of body) {
    if (e.k === 'ctx') {
      out.push(fl[pos + oi]!);
      oi += 1;
    } else if (e.k === 'old') {
      oi += 1;
    } else if (e.k === 'new') {
      out.push(tier === 2 ? reindent(e.s, F, P) : e.s);
    }
  }
  return out;
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USec {
  diffX?: string;
  diffY?: string;
  pair: boolean;
  oldP?: string | null;
  newP?: string | null;
  renFrom?: string;
  renTo?: string;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

/** `diff --git a/<X> b/<Y>`, or null when the line is not of that form. */
function diffPaths(l: string): [string, string] | null {
  const rest = l.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 3) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  return x === '' || y === '' ? null : [x, y];
}

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function hpath(l: string): string | null {
  let s = l.slice(4);
  const t = s.indexOf('\t');
  if (t >= 0) s = s.slice(0, t);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function uHeader(lines: string[], i: number, sec: USec): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@') || l === 'diff --git' || l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      const nx = lines[i + 1];
      if (nx !== undefined && nx.startsWith('+++ ')) {
        sec.oldP = hpath(l);
        sec.newP = hpath(nx);
        sec.pair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l === 'new file mode' || l.startsWith('new file mode ')) sec.isNew = true;
    else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) sec.isDel = true;
    else if (l.startsWith('rename from ')) sec.renFrom = l.slice('rename from '.length).trim();
    else if (l.startsWith('rename to ')) sec.renTo = l.slice('rename to '.length).trim();
    i += 1;
  }
  return i;
}

function uHunks(lines: string[], i: number, sec: USec): number {
  while (i < lines.length && lines[i]!.startsWith('@@')) {
    const m = HUNK_RE.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const h: Hunk = { a: Number(m[1]), body: [] };
    i += 1;
    let pend = 0;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l === '') {
        pend += 1;
      } else {
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = l[0]!;
        if (c !== ' ' && c !== '-' && c !== '+' && c !== '\\') break;
        while (pend > 0) {
          h.body.push({ k: 'ctx', s: '' });
          pend -= 1;
        }
        if (c === '\\') h.body.push({ k: 'bs', s: '' });
        else h.body.push({ k: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', s: l.slice(1) });
      }
      i += 1;
    }
    sec.hunks.push(h);
  }
  return i;
}

/** Whether a `\` line follows the body's last context or `+` line (the no-final-break mark). */
function noFinalBreak(h: Hunk): boolean {
  for (let j = h.body.length - 1; j >= 0; j--) {
    const k = h.body[j]!.k;
    if (k === 'ctx' || k === 'new') return h.body[j + 1]?.k === 'bs';
  }
  return false;
}

/** The hunks applied in order to the file's lines; its break is its own, the final one per section 6. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, errP: string): string {
  const f = splitFile(text);
  const cur = f.lines.slice();
  let fin = f.fin;
  let d = 0;
  for (const h of hunks) {
    const oLen = countBody(h.body, 'o');
    const nLen = countBody(h.body, 'n');
    if (oLen === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), cur.length);
      const ins = h.body.filter((e) => e.k === 'new').map((e) => e.s);
      const atEnd = pos === cur.length;
      cur.splice(pos, 0, ...ins);
      if (atEnd) fin = !noFinalBreak(h);
    } else {
      const o: string[] = h.body.filter((e) => e.k === 'ctx' || e.k === 'old').map((e) => e.s);
      const found = findO(cur, o, strict);
      if (found === null) throw new Fail('no-match', errP);
      const target = h.a - 1 + d;
      let pos = found.pos[0]!;
      for (const q of found.pos) {
        if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
      }
      const atEnd = pos + oLen === cur.length;
      cur.splice(pos, oLen, ...writtenN(h.body, cur, pos, found.tier));
      if (atEnd) fin = !noFinalBreak(h);
    }
    d += nLen - oLen;
  }
  return joinFile(cur, f.br, fin);
}

function uEdit(sec: USec, strict: boolean, moves: [string, string][]): Edit {
  const oldP = sec.pair ? sec.oldP : (sec.renFrom ?? sec.diffX);
  const newP = sec.pair ? sec.newP : (sec.renTo ?? sec.diffY);
  return (tree) => {
    const named: string[] = [];
    if (typeof oldP === 'string') named.push(oldP);
    if (typeof newP === 'string' && newP !== oldP) named.push(newP);
    for (const p of named) {
      if (!safe(p)) throw new Fail('unsafe', p);
    }
    if (oldP === null || sec.isNew) {
      const p = typeof newP === 'string' ? newP : '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let noBr = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          const e = h.body[j]!;
          if (e.k === 'new') {
            out.push(e.s);
            noBr = h.body[j + 1]?.k === 'bs';
          }
        }
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (noBr ? '' : '\n'));
      return;
    }
    if (newP === null || sec.isDel) {
      const p = typeof oldP === 'string' ? oldP : '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (typeof oldP !== 'string' || typeof newP !== 'string') {
      // A section always names both paths, so this is not reached; it keeps the move/change code below typed.
      throw new Fail('unsafe', '');
    }
    if (oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const res = applyHunks(tree.get(oldP)!, sec.hunks, strict, oldP);
      tree.now.set(newP, res);
      tree.now.set(oldP, null);
      moves.push([oldP, newP]);
      return;
    }
    const t = tree.get(oldP);
    if (t === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(t, sec.hunks, strict, oldP));
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const secs: USec[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || l === 'diff --git') {
      const xy = diffPaths(l);
      if (xy === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: USec = { diffX: xy[0], diffY: xy[1], pair: false, isNew: false, isDel: false, hunks: [] };
      i = uHunks(lines, uHeader(lines, i + 1, sec), sec);
      secs.push(sec);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: USec = { pair: false, isNew: false, isDel: false, hunks: [] };
      i = uHunks(lines, uHeader(lines, i, sec), sec);
      secs.push(sec);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return secs.map((s) => uEdit(s, strict, moves));
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function srEdit(path: string, o: string[], nw: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (o.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const f = splitFile(t);
    const cur = f.lines.slice();
    const found = findO(cur, o, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const rep = found.tier === 2 ? nw.map((s) => reindent(s, leadWS(cur[pos]!), leadWS(o[0]!))) : nw;
    cur.splice(pos, o.length, ...rep);
    tree.now.set(path, joinFile(cur, f.br, f.fin));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let after = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = i - 1; j >= after; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    const o: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      o.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    const nw: string[] = [];
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      nw.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(srEdit(path, o, nw, strict));
    prevPath = path;
    after = k + 1;
    i = k;
  }
  return edits;
}

// ---------- section 8: V4A patches ----------

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      const file: string[] = [];
      i += 1;
      let pend: number[] = [];
      while (i < last && !isStart(lines[i]!)) {
        const b = lines[i]!;
        if (blank(b)) {
          pend.push(i);
          i += 1;
          continue;
        }
        if (b[0] === '+') {
          for (const pi of pend) {
            if (lines[pi] !== '') throw new Exit2(`error: parse ${pi + 1}`);
            file.push('');
          }
          pend = [];
          file.push(b.slice(1));
        } else {
          const bad = pend.find((pi) => lines[pi] !== '');
          throw new Exit2(`error: parse ${(bad ?? i) + 1}`);
        }
        i += 1;
      }
      const p0 = p;
      edits.push((tree) => {
        if (!safe(p0)) throw new Fail('unsafe', p0);
        if (tree.get(p0) !== null) throw new Fail('exists', p0);
        tree.now.set(p0, file.length === 0 ? '' : `${file.join('\n')}\n`);
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && !isStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      const p0 = p;
      edits.push((tree) => {
        if (!safe(p0)) throw new Fail('unsafe', p0);
        if (tree.get(p0) === null) throw new Fail('missing', p0);
        tree.now.set(p0, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const upLine = i + 1;
      i += 1;
      let mov: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        mov = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let pend: number[] = [];
      const flush = (): void => {
        for (const pi of pend) {
          const r = lines[pi]!;
          if (r !== '' && r[0] !== ' ') throw new Exit2(`error: parse ${pi + 1}`);
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${pi + 1}`);
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push({ k: 'ctx', s: r === '' ? '' : r.slice(1) });
        }
        pend = [];
      };
      while (i < last && !isStart(lines[i]!)) {
        const b = lines[i]!;
        if (blank(b)) {
          pend.push(i);
          i += 1;
          continue;
        }
        if (b.startsWith('@@')) {
          flush();
          cur = { anchor: b.slice(2).trim() || null, body: [], eof: false };
          chunks.push(cur);
          i += 1;
          continue;
        }
        if (b.trim() === '*** End of File') {
          if (cur === null && pend.length === 0) throw new Exit2(`error: parse ${i + 1}`);
          flush();
          cur!.eof = true;
          cur = null;
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c !== ' ' && c !== '-' && c !== '+') throw new Exit2(`error: parse ${i + 1}`);
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
          cur = { anchor: null, body: [], eof: false };
          chunks.push(cur);
        }
        flush();
        cur.body.push({ k: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', s: b.slice(1) });
        i += 1;
      }
      if (chunks.length === 0 && mov === null) throw new Exit2(`error: parse ${upLine}`);
      const p0 = p;
      const m0 = mov;
      const ch0 = chunks;
      edits.push((tree) => {
        if (!safe(p0)) throw new Fail('unsafe', p0);
        if (m0 !== null && !safe(m0)) throw new Fail('unsafe', m0);
        const t = tree.get(p0);
        if (t === null) throw new Fail('missing', p0);
        if (m0 !== null && tree.get(m0) !== null) throw new Fail('exists', m0);
        const f = splitFile(t);
        const cur2 = f.lines.slice();
        let cursor = 0;
        for (const ch of ch0) {
          if (ch.anchor !== null) {
            let idx = -1;
            for (let tier = 0; tier <= (strict ? 0 : 2) && idx < 0; tier++) {
              for (let j = cursor; j < cur2.length; j++) {
                if (eqTier(cur2[j]!, ch.anchor, tier)) {
                  idx = j;
                  break;
                }
              }
            }
            if (idx < 0) throw new Fail('no-match', p0);
            cursor = idx + 1;
          }
          const o: string[] = ch.body.filter((e) => e.k === 'ctx' || e.k === 'old').map((e) => e.s);
          if (o.length === 0) {
            const pos = ch.eof ? cur2.length : Math.min(cursor, cur2.length);
            const ins = ch.body.filter((e) => e.k === 'new').map((e) => e.s);
            cur2.splice(pos, 0, ...ins);
            cursor = pos + ins.length;
          } else {
            const found = findO(cur2, o, strict, cursor, ch.eof);
            if (found === null) throw new Fail('no-match', p0);
            const pos = found.pos[0]!;
            const w = writtenN(ch.body, cur2, pos, found.tier);
            cur2.splice(pos, o.length, ...w);
            cursor = pos + w.length;
          }
        }
        const res = joinFile(cur2, f.br, f.fin);
        if (m0 !== null) {
          tree.now.set(m0, res);
          tree.now.set(p0, null);
          moves.push([p0, m0]);
        } else {
          tree.now.set(p0, res);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------- section 9: JSON edits ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- sections 1, 2 and 10: the command line, the output and the write ----------

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const status = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    status.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rowAt = new Map<string, string>();
  for (const [p, s] of status) rowAt.set(p, `${s} ${p}`);
  for (const [o, n] of moves) {
    if (status.get(o) === 'D' && status.get(n) === 'A') {
      rowAt.delete(o);
      rowAt.delete(n);
      rowAt.set(n, `R ${o} -> ${n}`);
    }
  }
  const rows = [...rowAt.keys()].sort(byteOrder).map((k) => rowAt.get(k)!);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
