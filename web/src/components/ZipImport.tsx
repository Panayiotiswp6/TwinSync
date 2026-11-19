import { FileArchive } from 'lucide-react';
import { strFromU8, unzipSync } from 'fflate';
import { useRef, useState } from 'react';
import { api, type AppState, type ImportPackage } from '../api';
import { Working } from './Composer';
import { go } from './Shell';
import { Badge } from './ui';

/** Reads the questionnaire ZIP (persona.json, NN-*.md, holdout.json) in the browser. */
export async function readTwinZip(file: File): Promise<ImportPackage> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const files: ImportPackage['files'] = [];
  let persona: ImportPackage['persona'] | null = null;
  let holdout: ImportPackage['holdout'];
  for (const [path, data] of Object.entries(entries)) {
    const name = path.split('/').pop() ?? path;
    if (!name || name.startsWith('.') || path.includes('__MACOSX')) continue;
    const text = strFromU8(data).replace(/^﻿/, '');
    if (name.toLowerCase() === 'persona.json') persona = JSON.parse(text);
    else if (name.toLowerCase() === 'holdout.json') holdout = JSON.parse(text);
    else if (/\.(md|txt)$/i.test(name)) files.push({ name, text });
  }
  if (!persona?.name || !persona?.handle) throw new Error('Λείπει το persona.json (με name και handle) από το ZIP.');
  if (!files.length) throw new Error('Δεν βρέθηκαν αρχεία .md / .txt στο ZIP.');
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { persona, files, holdout };
}

export function ZipImport({ live, onState, onDone }: { live: boolean; onState: (s: AppState) => void; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [pkg, setPkg] = useState<ImportPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    try {
      setPkg(await readTwinZip(f));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const run = async () => {
    if (!pkg) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.importPackage(pkg);
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

  return (
    <div className="zip-import">
      <button className="drop" onClick={() => input.current?.click()}>
        <FileArchive size={28} />
        <b>Εισαγωγή από ZIP ερωτηματολογίου</b>
        <span className="tiny muted">twinsync-&lt;handle&gt;.zip από το docs/persona-questionnaire.md</span>
      </button>
      <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={(e) => pick(e.target.files?.[0])} />
      {pkg && (
        <div className="zip-preview">
          <p>
            <b>
              {pkg.persona.emoji} {pkg.persona.name}
            </b>{' '}
            <span className="muted small">@{pkg.persona.handle}</span>
          </p>
          <p className="small muted">{pkg.persona.bio}</p>
          <ul className="plain file-list">
            {pkg.files.map((f) => (
              <li key={f.name} className="small">
                📄 {f.name} <span className="tiny muted">{f.text.length.toLocaleString('el-GR')} χαρ.</span>
              </li>
            ))}
            {pkg.holdout && <li className="small">🧪 holdout.json — {pkg.holdout.cases.length} αποφάσεις-τεστ (δεν μπαίνουν στο Twin)</li>}
          </ul>
          <div className="modal-actions">
            <Badge tone={live ? 'ai' : 'warn'}>{live ? 'Ανάλυση με AI' : 'Demo mode · κανόνες'}</Badge>
            <button className="btn btn-brand" onClick={run}>
              Εισαγωγή Twin
            </button>
          </div>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
