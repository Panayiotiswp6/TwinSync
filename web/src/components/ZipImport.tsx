import { FileArchive } from 'lucide-react';
import { strFromU8, unzipSync } from 'fflate';
import { useRef, useState } from 'react';
import { api, type AppState, type ImportPackage } from '../api';
import { Working } from './Composer';
import { go } from './Shell';
import { Badge } from './ui';

export interface ZipContents {
  persona: Partial<ImportPackage['persona']> | null;
  files: ImportPackage['files'];
  holdout?: ImportPackage['holdout'];
  warnings: string[];
}

const BOM = /^﻿/;
const HANDLE = /^@?[a-z0-9._-]{2,30}$/i;

function parseJson(text: string, name: string, warnings: string[]): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // ChatGPT sometimes wraps JSON in ``` fences or adds a sentence around it.
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    warnings.push(`Το ${name} δεν είναι έγκυρο JSON — παραλείφθηκε.`);
    return null;
  }
}

/** Reads the questionnaire ZIP in the browser. Tolerant: only the text files are mandatory. */
export async function readTwinZip(file: File): Promise<ZipContents> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error('Το αρχείο δεν ανοίγει ως ZIP. Κατεβάστε το ξανά από το ChatGPT, ή επιλέξτε τα αρχεία → δεξί κλικ → «Συμπίεση».');
  }
  const files: ImportPackage['files'] = [];
  const warnings: string[] = [];
  let persona: ZipContents['persona'] = null;
  let holdout: ImportPackage['holdout'];
  for (const [path, data] of Object.entries(entries)) {
    const name = path.split('/').pop() ?? path;
    if (!name || name.startsWith('.') || path.includes('__MACOSX')) continue;
    const text = strFromU8(data).replace(BOM, '');
    const lower = name.toLowerCase();
    if (lower.endsWith('.json') && lower.includes('persona')) persona = parseJson(text, name, warnings) as ZipContents['persona'];
    else if (lower.endsWith('.json') && lower.includes('holdout')) holdout = parseJson(text, name, warnings) as ImportPackage['holdout'];
    else if (/\.(md|txt|markdown)$/i.test(name)) {
      const body = text.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      if (body.length < 5) warnings.push(`Το ${name} είναι άδειο — παραλείφθηκε.`);
      else files.push({ name, text });
    }
  }
  if (!files.length) throw new Error('Δεν βρέθηκαν αρχεία .md / .txt με περιεχόμενο μέσα στο ZIP.');
  files.sort((a, b) => a.name.localeCompare(b.name));
  if (!persona?.handle) {
    // Recover the handle from the source ids ("id: src-<handle>-01").
    const fromIds = files.map((f) => f.text.match(/^id:\s*src-(.+)-\d+\s*$/m)?.[1]).find(Boolean);
    persona = { ...(persona ?? {}), handle: fromIds ?? '' };
  }
  return { persona, files, holdout, warnings };
}

export function ZipImport({ live, onState, onDone }: { live: boolean; onState: (s: AppState) => void; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [pkg, setPkg] = useState<ZipContents | null>(null);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    try {
      const z = await readTwinZip(f);
      setPkg(z);
      setName(z.persona?.name ?? '');
      setHandle((z.persona?.handle ?? '').replace(/^@/, ''));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const run = async () => {
    if (!pkg) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.importPackage({
        persona: { name: name.trim(), handle: handle.trim().replace(/^@/, ''), emoji: pkg.persona?.emoji, bio: pkg.persona?.bio },
        files: pkg.files,
        holdout: pkg.holdout,
      });
      onState(r.state);
      onDone();
      go(`/twin/${r.persona.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (busy) return <Working live={live} steps={['Άνοιγμα ZIP', 'Πηγές στη μόνιμη μνήμη', 'Εξαγωγή αναμνήσεων με παραπομπές', 'Ανάλυση ύφους γραφής', 'Αποφάσεις-τεστ για την αξιολόγηση']} />;

  const cases = Array.isArray(pkg?.holdout?.cases) ? pkg!.holdout!.cases.length : 0;
  return (
    <div className="zip-import">
      <button className="drop" onClick={() => input.current?.click()}>
        <FileArchive size={28} />
        <b>Εισαγωγή από ZIP ερωτηματολογίου</b>
        <span className="tiny muted">twinsync-&lt;handle&gt;.zip από το docs/persona-questionnaire.md</span>
      </button>
      <input ref={input} type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden onChange={(e) => pick(e.target.files?.[0])} />
      {pkg && (
        <div className="zip-preview">
          <div className="zip-fields">
            <label className="field">
              Όνομα
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="π.χ. Γρηγόρης Πατέλης" />
            </label>
            <label className="field">
              Handle
              <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="π.χ. gregpat" />
            </label>
          </div>
          {pkg.persona?.bio && <p className="small muted">{pkg.persona.bio}</p>}
          <ul className="plain file-list">
            {pkg.files.map((f) => (
              <li key={f.name} className="small">
                📄 {f.name} <span className="tiny muted">{f.text.length.toLocaleString('el-GR')} χαρ.</span>
              </li>
            ))}
            {cases > 0 && <li className="small">🧪 holdout.json — {cases} αποφάσεις-τεστ (δεν μπαίνουν στο Twin)</li>}
          </ul>
          {pkg.warnings.map((w) => (
            <p key={w} className="tiny warn-text">
              ⚠ {w}
            </p>
          ))}
          <div className="modal-actions">
            <Badge tone={live ? 'ai' : 'warn'}>{live ? 'Ανάλυση με AI' : 'Demo mode · κανόνες'}</Badge>
            <button className="btn btn-brand" disabled={name.trim().length < 2 || !HANDLE.test(handle.trim())} onClick={run}>
              Εισαγωγή Twin
            </button>
          </div>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
