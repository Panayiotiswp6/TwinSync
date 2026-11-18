import { FileUp } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Persona } from '../../../shared/types';
import { api, type AnalyzeResult, type AppState } from '../api';
import { Working } from './Composer';
import { Badge, Modal, SOURCE_KIND } from './ui';

const KINDS = ['document', 'note', 'chat', 'email', 'past_decision'] as const;
const ACCEPT = '.txt,.md,.markdown,.json,.csv,.eml,.log';

export function UploadModal({ persona, live, onClose, onState, onResult }: { persona: Persona; live: boolean; onClose: () => void; onState: (s: AppState) => void; onResult: (r: AnalyzeResult[]) => void }) {
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('document');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const readFiles = async (list: FileList | null) => {
    if (!list) return;
    const out: { name: string; text: string }[] = [];
    for (const f of Array.from(list)) {
      if (f.size > 400_000) {
        setErr(`${f.name}: πολύ μεγάλο αρχείο (όριο 400KB).`);
        continue;
      }
      out.push({ name: f.name, text: await f.text() });
    }
    setFiles((x) => [...x, ...out]);
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const results: AnalyzeResult[] = [];
      const jobs = [...files.map((f) => ({ title: f.name.replace(/\.[^.]+$/, ''), text: f.text, fileName: f.name })), ...(text.trim() ? [{ title: title || 'Σημείωση', text, fileName: undefined }] : [])];
      for (const j of jobs) {
        const r = await api.addSource(persona.id, { title: j.title, text: j.text, kind, fileName: j.fileName });
        results.push(r);
        onState(r.state);
      }
      onResult(results);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Νέες πηγές για ${persona.name}`} onClose={onClose} wide>
      {busy ? (
        <Working live={live} steps={['Ανάγνωση αρχείων', 'Εξαγωγή αναμνήσεων', 'Έλεγχος αποσπασμάτων', 'Σφραγίδα μνήμης (OpenSelf)']} />
      ) : (
        <>
          <div
            className={`drop ${drag ? 'drag' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              readFiles(e.dataTransfer.files);
            }}
            onClick={() => input.current?.click()}
          >
            <FileUp size={28} />
            <b>Σύρετε αρχεία εδώ ή πατήστε για επιλογή</b>
            <span className="tiny muted">.txt .md .json .csv .eml — σημειώσεις, chats, emails, βιογραφικό, παλιές αποφάσεις</span>
            <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => readFiles(e.target.files)} />
          </div>
          {files.length > 0 && (
            <ul className="plain file-list">
              {files.map((f, i) => (
                <li key={f.name + i}>
                  📄 {f.name} <span className="tiny muted">{f.text.length.toLocaleString('el-GR')} χαρακτήρες</span>
                  <button className="link-btn tiny" onClick={() => setFiles((x) => x.filter((_, k) => k !== i))}>
                    αφαίρεση
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="or">ή επικόλληση κειμένου</div>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Τίτλος (π.χ. Chat με την παρέα)" />
          <textarea className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Επικολλήστε σημειώσεις, μηνύματα, ένα email ή μια παλιά απόφαση με την αιτιολόγησή της…" />
          <div className="kind-pick">
            {KINDS.map((k) => (
              <button key={k} className={`chip ${kind === k ? 'chip-on' : ''}`} onClick={() => setKind(k)}>
                {SOURCE_KIND[k].emoji} {SOURCE_KIND[k].label}
              </button>
            ))}
          </div>
          <div className="modal-actions">
            <Badge tone={live ? 'ai' : 'warn'}>{live ? 'Ανάλυση με AI' : 'Demo mode · ανάλυση με κανόνες'}</Badge>
            <button className="btn btn-brand" disabled={!files.length && text.trim().length < 5} onClick={submit}>
              Ανάλυση & αποθήκευση
            </button>
          </div>
          <p className="tiny muted">Οι πηγές αποθηκεύονται μόνιμα. Ό,τι εξάγει το AI μπαίνει «προς έλεγχο» — στο προφίλ μπαίνει μόνο ό,τι επιβεβαιώσει ο κάτοχος. Μόνο δικά σας ή συνθετικά δεδομένα.</p>
        </>
      )}
      {err && <p className="error">{err}</p>}
    </Modal>
  );
}
