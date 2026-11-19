import { useState } from 'react';
import { api, type AppState } from '../api';
import { go } from './Shell';
import { Modal } from './ui';
import { ZipImport } from './ZipImport';

const EMOJIS = ['✨', '🎧', '📚', '🏄', '🎨', '⚽', '🍕', '🌿', '🚴', '🎮'];

export function NewTwinModal({ onClose, onState, live = false }: { onClose: () => void; onState: (s: AppState) => void; live?: boolean }) {
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [emoji, setEmoji] = useState('✨');
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    try {
      const r = await api.createPersona(name, bio, emoji);
      onState(r.state);
      onClose();
      go(`/twin/${r.persona.id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Modal title="Νέο Twin" onClose={onClose}>
      <ZipImport live={live} onState={onState} onDone={onClose} />
      <div className="or">ή δημιουργία με το χέρι</div>
      <p className="muted small">Δημιουργήστε ένα Twin και μετά ανεβάστε αρχεία, σημειώσεις και chats του κατόχου. Χρησιμοποιήστε μόνο δικά σας δεδομένα με συναίνεση ή συνθετικά.</p>
      <label className="field">
        Όνομα
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="π.χ. Μαρία" autoFocus />
      </label>
      <label className="field">
        Λίγα λόγια
        <input value={bio} onChange={(e) => setBio(e.target.value)} placeholder="π.χ. Αρχιτέκτονας · σινεμά, θάλασσα" />
      </label>
      <div className="emoji-pick">
        {EMOJIS.map((e) => (
          <button key={e} className={e === emoji ? 'on' : ''} onClick={() => setEmoji(e)}>
            {e}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn btn-brand" disabled={name.trim().length < 2} onClick={create}>
          Δημιουργία
        </button>
      </div>
      {err && <p className="error">{err}</p>}
    </Modal>
  );
}
