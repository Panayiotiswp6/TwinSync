// In-app onboarding interview. Each question is chosen for what the twin needs to decide and
// write like its owner: money per context (evening / weekend in Greece / days abroad), time
// limits, food, travel and stay, going out, how they compromise, and how they write.
// Answers are stored verbatim as the twin's sources (Ε:/Α: lines); clear-cut answers become
// memory directly in code (with context and strictness), free text is analysed by the AI.

import type { MemoryDraft } from './heuristics';
import type { Category, Where } from './types';

export type QType = 'text' | 'money' | 'chips' | 'multi' | 'deadline' | 'dm';

export interface Question {
  id: string;
  q: string;
  type: QType;
  help?: string;
  placeholder?: string;
  options?: string[];
  optional?: boolean;
  /** money: the situation the amount refers to (becomes the memory's context). */
  money?: { where: Where; days: number; categories: Category[]; label: string };
}

export interface Section {
  id: string;
  title: string;
  emoji: string;
  intro: string;
  questions: Question[];
}

export interface MoneyAnswer {
  amount: number | null;
  strict: boolean;
}
export interface DeadlineAnswer {
  day: number | null;
  time: string;
  strict: boolean;
}
export type Answer = string | string[] | MoneyAnswer | DeadlineAnswer;
export type Answers = Record<string, Answer>;

export const WEEKDAY_NAMES = ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'];
export const NONE = 'Τίποτα από αυτά';

export const SECTIONS: Section[] = [
  {
    id: 'me',
    title: 'Εσύ',
    emoji: '👋',
    intro: 'Λίγα βασικά για να σε γνωρίσει το Twin σου.',
    questions: [
      { id: 'me_friend', q: 'Πώς θα σε περιέγραφε ένας κολλητός σου με μία πρόταση;', type: 'text', placeholder: 'π.χ. «ο πρώτος που λέει ναι σε όλα, αλλά πάντα αργεί»' },
      { id: 'me_daily', q: 'Τι κάνεις στην καθημερινότητά σου (δουλειά, σχολή) και πότε είσαι συνήθως ελεύθερος/η;', type: 'text', placeholder: 'π.χ. δουλεύω Δευ–Παρ 9–5, τα ΣΚ είμαι ελεύθερος' },
    ],
  },
  {
    id: 'money',
    title: 'Χρήματα',
    emoji: '💶',
    intro: 'Γράψε τι δίνεις συνήθως σε κάθε περίσταση. Το Twin το χρησιμοποιεί ως ένδειξη μόνο για παρόμοιες περιστάσεις — γίνεται όριο μόνο αν το σημειώσεις ως αυστηρό.',
    questions: [
      { id: 'money_evening', q: 'Μια βραδινή έξοδος στην πόλη (φαγητό ή ποτό): πόσα δίνεις συνήθως;', type: 'money', money: { where: 'local', days: 1, categories: ['food', 'entertainment'], label: 'για βραδινή έξοδο στην πόλη' } },
      { id: 'money_weekend', q: 'Ένα διήμερο στην Ελλάδα, όλα μαζί (μετακίνηση, διαμονή, φαγητό): πόσα δίνεις συνήθως;', type: 'money', money: { where: 'domestic', days: 2, categories: ['trip'], label: 'για διήμερο στην Ελλάδα' } },
      { id: 'money_abroad', q: 'Ένα ταξίδι 4–5 ημερών στο εξωτερικό, όλα μαζί με εισιτήρια: πόσα θα έδινες;', type: 'money', optional: true, money: { where: 'abroad', days: 4, categories: ['trip'], label: 'για 4ήμερο στο εξωτερικό' } },
      { id: 'money_gift', q: 'Για ένα κοινό δώρο σε φίλο, πόσα βάζεις εσύ;', type: 'money', optional: true, money: { where: 'any', days: 0, categories: ['gift'], label: 'για κοινό δώρο σε φίλο' } },
      { id: 'money_worth', q: 'Για τι αξίζει να πληρώσεις παραπάνω και πού κάνεις οικονομία;', type: 'text', placeholder: 'π.χ. «για καλό φαγητό ναι, για ξενοδοχείο όχι — αρκεί να είναι καθαρό»' },
    ],
  },
  {
    id: 'time',
    title: 'Χρόνος',
    emoji: '⏰',
    intro: 'Πώς σου ταιριάζει να κυλάει ο χρόνος σε εκδρομές και εξόδους.',
    questions: [
      { id: 'time_early', q: 'Αναχώρηση για εκδρομή στις 7 το πρωί;', type: 'chips', options: ['Κανένα πρόβλημα', 'Αν πρέπει…', 'Όχι πριν τις 9–10'] },
      { id: 'time_night', q: 'Μέχρι τι ώρα σου αρέσει να κρατάει μια βραδινή έξοδος;', type: 'chips', options: ['Ως τις 12', 'Γύρω στις 2', 'Μέχρι να ξημερώσει'] },
      { id: 'time_fixed', q: 'Σταθερές υποχρεώσεις που πρέπει να ξέρει το Twin σου; (μέρες, ώρες, γιατί)', type: 'text', optional: true, placeholder: 'π.χ. προπόνηση Τρίτη & Πέμπτη 19:00, Σάββατο πρωί δουλεύω' },
    ],
  },
  {
    id: 'food',
    title: 'Φαγητό',
    emoji: '🍽️',
    intro: 'Ό,τι δεν τρως ποτέ γίνεται υποχρεωτικός περιορισμός· τα υπόλοιπα είναι προτιμήσεις.',
    questions: [
      { id: 'food_no', q: 'Τι δεν τρως σε καμία περίπτωση;', type: 'multi', options: ['Κρέας (χορτοφάγος)', 'Τίποτα ζωικό (vegan)', 'Γλουτένη', 'Θαλασσινά', 'Χοιρινό', 'Λακτόζη', NONE] },
      { id: 'food_allergy', q: 'Αλλεργίες ή κάτι άλλο που πρέπει να ξέρει η παρέα;', type: 'text', optional: true },
      { id: 'food_pick', q: 'Αν διάλεγες εσύ πού θα φάει όλη η παρέα, τι θα διάλεγες και γιατί;', type: 'text', placeholder: 'π.χ. «ταβέρνα με μεζέδες, να μοιραζόμαστε τα πάντα»' },
      { id: 'food_bad', q: 'Τι σου χαλάει ένα μαγαζί;', type: 'text', optional: true, placeholder: 'θόρυβος, αναμονή, μικρές μερίδες, ακριβό κρασί…' },
    ],
  },
  {
    id: 'travel',
    title: 'Ταξίδια',
    emoji: '🧳',
    intro: 'Τι σε κάνει να λες «μέσα» σε ένα ταξίδι — και τι σε κάνει να μην έρθεις.',
    questions: [
      { id: 'travel_like', q: 'Τι σε τραβάει σε ένα ταξίδι;', type: 'multi', options: ['Θάλασσα & παραλίες', 'Βουνό & πεζοπορία', 'Πόλη & μουσεία', 'Φαγητό & κρασί', 'Νυχτερινή ζωή', 'Χαλάρωση', 'Περιπέτεια & σπορ'] },
      { id: 'travel_stay_no', q: 'Ποια διαμονή δεν δέχεσαι;', type: 'multi', options: ['Σκηνή / κάμπινγκ', 'Κοινόχρηστο μπάνιο', 'Κοινό δωμάτιο με αγνώστους (hostel)', 'Καναπές σε σπίτι φίλων', NONE] },
      { id: 'travel_move_no', q: 'Τι μετακίνηση σε κουράζει;', type: 'multi', options: ['Πάνω από 4 ώρες στο αυτοκίνητο', 'Πλοίο (ζαλίζομαι)', 'Πτήσεις', 'Να οδηγώ εγώ', NONE] },
      { id: 'travel_best', q: 'Το καλύτερο ταξίδι με φίλους που έχεις κάνει: τι ακριβώς το έκανε τέλειο;', type: 'text', placeholder: 'πού, με τι διαμονή, τι κάνατε, τι θυμάσαι' },
      { id: 'travel_worst', q: 'Κι ένα που δεν σου άρεσε — τι πήγε στραβά;', type: 'text', optional: true },
    ],
  },
  {
    id: 'social',
    title: 'Έξοδος',
    emoji: '🎉',
    intro: 'Για τις βραδιές με την παρέα.',
    questions: [
      { id: 'social_like', q: 'Η ιδανική βραδιά με την παρέα;', type: 'multi', options: ['Ταβέρνα & κουβέντα', 'Ήσυχο μπαρ / κρασί', 'Club & χορός', 'Live μουσική', 'Σινεμά / θέατρο', 'Επιτραπέζια στο σπίτι', 'Καφές & βόλτα'] },
      { id: 'social_people', q: 'Νέα άτομα στην παρέα;', type: 'chips', options: ['Τα λατρεύω', 'Λίγα, οκ', 'Προτιμώ τους δικούς μας'] },
      { id: 'social_music', q: 'Τι μουσική δεν αντέχεις και τι σε σηκώνει να χορέψεις;', type: 'text', optional: true },
    ],
  },
  {
    id: 'decide',
    title: 'Αποφάσεις',
    emoji: '⚖️',
    intro: 'Πώς αποφασίζεις μέσα στην παρέα — αυτό κάνει το Twin να διαπραγματεύεται σαν εσένα.',
    questions: [
      { id: 'decide_style', q: 'Όταν η παρέα διαφωνεί, εσύ συνήθως…', type: 'chips', options: ['Υποχωρώ για να πάμε', 'Φέρνω επιχειρήματα μέχρι να πείσω', 'Προτείνω ψηφοφορία', 'Αν δεν μου κάθεται, δεν έρχομαι'] },
      { id: 'decide_never', q: 'Σε τι δεν κάνεις ΠΟΤΕ συμβιβασμό, ακόμα κι αν όλοι οι άλλοι το θέλουν;', type: 'text', placeholder: 'π.χ. «δεν κοιμάμαι ποτέ σε σκηνή», «όχι πάνω από 3 ώρες δρόμο»' },
      { id: 'decide_flex', q: 'Και σε τι είσαι εντελώς ευέλικτος/η;', type: 'text', optional: true },
      { id: 'decide_past', q: 'Μια πρόσφατη απόφαση της παρέας: τι πρότεινες εσύ, τι έγινε τελικά και πώς σου φάνηκε;', type: 'text', placeholder: 'π.χ. «ήθελα Πήλιο, πήγαμε Ναύπλιο γιατί ήταν πιο κοντά, τελικά καλά ήταν»' },
    ],
  },
  {
    id: 'voice',
    title: 'Πώς γράφεις',
    emoji: '💬',
    intro: 'Απάντησε όπως θα απαντούσες στο group chat — με τις συντομογραφίες, τα emoji και τα greeklish σου. Από εδώ το Twin μαθαίνει να γράφει σαν εσένα.',
    questions: [
      { id: 'dm_weekend', q: 'Ρε σεις, πάμε κάπου το ΣΚ; 🚗', type: 'dm' },
      { id: 'dm_airbnb', q: 'Βρήκα airbnb στη Νάξο, 85€ το άτομο τη βραδιά. Κλείνω;', type: 'dm' },
      { id: 'dm_early', q: 'Λέω να φύγουμε 6:30 το πρωί για να το προλάβουμε', type: 'dm' },
      { id: 'dm_cancel', q: 'Άκυρο για απόψε, δεν μπορώ τελικά 😩', type: 'dm' },
      { id: 'dm_food', q: 'Πού τρώμε Παρασκευή; Πείτε κάτι γιατί πάλι σουβλάκια θα καταλήξουμε', type: 'dm' },
      { id: 'voice_paste', q: 'Προαιρετικά: επικόλλησε μερικά πραγματικά μηνύματα που έχεις στείλει (μόνο δικά σου).', type: 'text', optional: true, placeholder: 'ένα μήνυμα ανά γραμμή' },
    ],
  },
];

export const DM_SENDERS = ['Μαρία', 'Νίκος', 'Ελένη', 'Κώστας', 'Δανάη'];

/** Exact text of an answer as stored in the source (the quote memory items point to). */
export function answerText(q: Question, a: Answer | undefined): string {
  if (a === undefined || a === null) return '';
  if (q.type === 'money') {
    const m = a as MoneyAnswer;
    if (m.amount === null || !Number.isFinite(m.amount) || m.amount <= 0) return '';
    return `${Math.round(m.amount)}€ ${q.money?.label ?? ''} — ${m.strict ? 'αυστηρό όριο' : 'ενδεικτικά, ανάλογα την περίσταση'}`.replace(/\s+/g, ' ');
  }
  if (q.type === 'deadline') {
    const d = a as DeadlineAnswer;
    if (d.day === null || d.day < 0 || d.day > 6 || !/^\d{1,2}:\d{2}$/.test(d.time)) return '';
    return `${WEEKDAY_NAMES[d.day]} ${d.time} — ${d.strict ? 'αυστηρό, πρέπει να έχω γυρίσει' : 'κατά προτίμηση'}`;
  }
  if (Array.isArray(a)) return a.filter(Boolean).join(', ');
  return String(a).trim();
}

/** The source text of a section: question and answer lines, exactly as the owner gave them. */
export function sectionText(s: Section, answers: Answers): string {
  return s.questions
    .filter((q) => q.id !== 'voice_paste')
    .map((q) => ({ q, a: answerText(q, answers[q.id]) }))
    .filter((x) => x.a)
    .map((x) => `Ε: ${x.q.type === 'dm' ? `(μήνυμα στην παρέα) ${x.q.q}` : x.q.q}\nΑ: ${x.a}`)
    .join('\n');
}

/** Only the free-text Q/As of a section — what the AI analyses (clear-cut answers become memory in code). */
export function freeText(s: Section, answers: Answers): string {
  return s.questions
    .filter((q) => (q.type === 'text' || q.type === 'dm') && q.id !== 'voice_paste')
    .map((q) => ({ q, a: answerText(q, answers[q.id]) }))
    .filter((x) => x.a.length >= 2)
    .map((x) => `Ε: ${x.q.type === 'dm' ? `(μήνυμα στην παρέα) ${x.q.q}` : x.q.q}\nΑ: ${x.a}`)
    .join('\n');
}

const draft = (d: Partial<MemoryDraft> & Pick<MemoryDraft, 'statement' | 'quote' | 'domain'>): MemoryDraft => ({
  kind: 'preference',
  polarity: 'likes',
  strength: 0.6,
  hard: false,
  categories: [],
  keywords: [],
  confidence: 1,
  ...d,
});

const FOOD_NO: Record<string, { statement: string; keywords: string[] }> = {
  'Κρέας (χορτοφάγος)': { statement: 'Χορτοφάγος — χρειάζεται επιλογές χωρίς κρέας', keywords: ['χορτοφαγικ', 'χωρίς κρέας', 'vegan', 'λαχανικά'] },
  'Τίποτα ζωικό (vegan)': { statement: 'Vegan — χρειάζεται επιλογές χωρίς ζωικά προϊόντα', keywords: ['vegan', 'φυτικ', 'χωρίς κρέας'] },
  Γλουτένη: { statement: 'Δεν τρώει γλουτένη — χρειάζεται επιλογές χωρίς γλουτένη', keywords: ['χωρίς γλουτένη', 'gluten free'] },
  Θαλασσινά: { statement: 'Δεν τρώει θαλασσινά', keywords: ['θαλασσινά', 'ψαροταβέρνα', 'οστρακοειδή'] },
  Χοιρινό: { statement: 'Δεν τρώει χοιρινό', keywords: ['χοιρινό'] },
  Λακτόζη: { statement: 'Δεν τρώει λακτόζη — χρειάζεται επιλογές χωρίς γαλακτοκομικά', keywords: ['χωρίς λακτόζη'] },
};
const STAY_NO: Record<string, { statement: string; keywords: string[] }> = {
  'Σκηνή / κάμπινγκ': { statement: 'Δεν κοιμάται σε σκηνή / κάμπινγκ', keywords: ['σκηνή', 'κάμπινγκ', 'camping'] },
  'Κοινόχρηστο μπάνιο': { statement: 'Δεν δέχεται κοινόχρηστο μπάνιο — θέλει ιδιωτικό', keywords: ['κοινόχρηστο μπάνιο', 'κοινό μπάνιο', 'shared bathroom'] },
  'Κοινό δωμάτιο με αγνώστους (hostel)': { statement: 'Δεν μένει σε κοινό δωμάτιο με αγνώστους (hostel)', keywords: ['hostel', 'κοινό δωμάτιο', 'κοιτώνας', 'dorm'] },
  'Καναπές σε σπίτι φίλων': { statement: 'Δεν κοιμάται σε καναπέ σε σπίτι φίλων', keywords: ['καναπές'] },
};
const MOVE_NO: Record<string, { statement: string; keywords: string[] }> = {
  'Πάνω από 4 ώρες στο αυτοκίνητο': { statement: 'Κουράζεται με πάνω από 4 ώρες στο αυτοκίνητο', keywords: ['5 ώρες', '6 ώρες', 'πολλές ώρες δρόμο'] },
  'Πλοίο (ζαλίζομαι)': { statement: 'Ζαλίζεται στο πλοίο — το αποφεύγει', keywords: ['πλοίο', 'φέρι', 'καράβι'] },
  Πτήσεις: { statement: 'Αποφεύγει τις πτήσεις', keywords: ['πτήση', 'αεροπλάνο'] },
  'Να οδηγώ εγώ': { statement: 'Δεν θέλει να οδηγεί ο ίδιος/η ίδια', keywords: ['οδήγηση'] },
};
const LIKES: Record<string, { statement: string; keywords: string[]; domain: MemoryDraft['domain'] }> = {
  'Θάλασσα & παραλίες': { statement: 'Σε ταξίδι τον/την τραβάει η θάλασσα', keywords: ['θάλασσα', 'παραλία', 'νησί', 'βουτιά'], domain: 'activities' },
  'Βουνό & πεζοπορία': { statement: 'Σε ταξίδι τον/την τραβάει το βουνό και η πεζοπορία', keywords: ['βουνό', 'πεζοπορία', 'μονοπάτι'], domain: 'activities' },
  'Πόλη & μουσεία': { statement: 'Σε ταξίδι του/της αρέσουν πόλεις και μουσεία', keywords: ['πόλη', 'μουσείο', 'αξιοθέατα', 'ιστορικ'], domain: 'activities' },
  'Φαγητό & κρασί': { statement: 'Σε ταξίδι δίνει σημασία στο φαγητό και το κρασί', keywords: ['φαγητό', 'κρασί', 'ταβέρνα', 'γαστρονομ'], domain: 'food' },
  'Νυχτερινή ζωή': { statement: 'Σε ταξίδι θέλει νυχτερινή ζωή', keywords: ['νυχτερινή ζωή', 'μπαρ', 'club', 'πάρτι'], domain: 'social' },
  Χαλάρωση: { statement: 'Σε ταξίδι θέλει χαλάρωση, χωρίς πρόγραμμα', keywords: ['χαλαρ', 'ήσυχ', 'ξεκούραση', 'spa'], domain: 'comfort' },
  'Περιπέτεια & σπορ': { statement: 'Σε ταξίδι θέλει περιπέτεια και σπορ', keywords: ['rafting', 'καγιάκ', 'αναρρίχηση', 'περιπέτεια', 'σπορ'], domain: 'activities' },
  'Ταβέρνα & κουβέντα': { statement: 'Ιδανική βραδιά: ταβέρνα και κουβέντα', keywords: ['ταβέρνα', 'μεζέδες', 'κουβέντα'], domain: 'social' },
  'Ήσυχο μπαρ / κρασί': { statement: 'Ιδανική βραδιά: ήσυχο μπαρ ή κρασί', keywords: ['wine bar', 'κρασί', 'ήσυχο μπαρ', 'cocktail'], domain: 'social' },
  'Club & χορός': { statement: 'Ιδανική βραδιά: club και χορός', keywords: ['club', 'χορός', 'dj', 'πάρτι'], domain: 'social' },
  'Live μουσική': { statement: 'Ιδανική βραδιά: live μουσική', keywords: ['live', 'συναυλία', 'μουσική σκηνή'], domain: 'social' },
  'Σινεμά / θέατρο': { statement: 'Ιδανική βραδιά: σινεμά ή θέατρο', keywords: ['σινεμά', 'θέατρο', 'ταινία', 'παράσταση'], domain: 'activities' },
  'Επιτραπέζια στο σπίτι': { statement: 'Ιδανική βραδιά: επιτραπέζια στο σπίτι', keywords: ['επιτραπέζια', 'board game', 'σπίτι'], domain: 'social' },
  'Καφές & βόλτα': { statement: 'Ιδανική βραδιά: καφές και βόλτα', keywords: ['καφές', 'βόλτα', 'περίπατος'], domain: 'social' },
};

/** Memory created in code from the clear-cut answers (chips, amounts, deadlines). */
export function structuredDrafts(answers: Answers): MemoryDraft[] {
  const out: MemoryDraft[] = [];
  const q = (id: string) => SECTIONS.flatMap((s) => s.questions).find((x) => x.id === id)!;
  const text = (id: string) => answerText(q(id), answers[id]);
  const list = (id: string) => (Array.isArray(answers[id]) ? (answers[id] as string[]) : []);

  for (const s of SECTIONS) {
    for (const x of s.questions.filter((y) => y.type === 'money' && y.money)) {
      const a = answers[x.id] as MoneyAnswer | undefined;
      const quote = text(x.id);
      if (!a || !quote) continue;
      const v = Math.round(a.amount!);
      out.push(
        draft({
          kind: a.strict ? 'constraint' : 'preference',
          statement: a.strict ? `Όριο ${v}€ ανά άτομο ${x.money!.label}` : `Συνήθως δίνει έως ~${v}€ ${x.money!.label} (ενδεικτικό)`,
          domain: 'money',
          polarity: 'neutral',
          strength: a.strict ? 1 : 0.6,
          hard: a.strict,
          rule: { metric: 'max_cost', value: String(v) },
          context: { where: x.money!.where, days: x.money!.days },
          categories: x.money!.categories,
          quote,
        }),
      );
    }
  }

  const early = text('time_early');
  if (early === 'Όχι πριν τις 9–10') out.push(draft({ statement: 'Αποφεύγει τις πρωινές αναχωρήσεις — όχι πριν τις 9–10', domain: 'schedule', polarity: 'avoids', strength: 0.7, keywords: ['06:', '07:', '08:', 'ξημερώματα', 'πολύ νωρίς'], quote: early }));
  else if (early === 'Κανένα πρόβλημα') out.push(draft({ statement: 'Δεν τον/την πειράζει να ξεκινήσουν πολύ νωρίς', domain: 'schedule', polarity: 'neutral', strength: 0.3, quote: early }));

  const night = text('time_night');
  if (night) {
    const late = night === 'Μέχρι να ξημερώσει';
    out.push(draft({ statement: late ? 'Του/της αρέσει να κρατάει η έξοδος μέχρι το ξημέρωμα' : `Προτιμά η βραδινή έξοδος να τελειώνει ${night.toLowerCase()}`, domain: 'schedule', polarity: late ? 'likes' : 'avoids', strength: 0.5, categories: ['entertainment', 'food'], keywords: late ? ['ξημέρωμα', 'after', 'club'] : ['ξημέρωμα', 'after', '04:', '05:'], quote: night }));
  }

  for (const it of list('food_no')) {
    const f = FOOD_NO[it];
    if (f) out.push(draft({ kind: 'constraint', statement: f.statement, domain: 'food', polarity: 'likes', strength: 1, hard: true, categories: ['food'], keywords: f.keywords, quote: text('food_no') }));
  }
  for (const it of list('travel_stay_no')) {
    const f = STAY_NO[it];
    if (f) out.push(draft({ kind: 'constraint', statement: f.statement, domain: 'comfort', polarity: 'avoids', strength: 1, hard: true, categories: ['trip'], keywords: f.keywords, quote: text('travel_stay_no') }));
  }
  for (const it of list('travel_move_no')) {
    const f = MOVE_NO[it];
    if (f) out.push(draft({ statement: f.statement, domain: 'travel', polarity: 'avoids', strength: 0.7, categories: ['trip'], keywords: f.keywords, quote: text('travel_move_no') }));
  }
  for (const id of ['travel_like', 'social_like']) {
    for (const it of list(id)) {
      const f = LIKES[it];
      if (f) out.push(draft({ statement: f.statement, domain: f.domain, strength: 0.7, categories: id === 'travel_like' ? ['trip'] : ['entertainment', 'food', 'activity'], keywords: f.keywords, quote: text(id) }));
    }
  }

  const people = text('social_people');
  if (people) out.push(draft({ statement: people === 'Τα λατρεύω' ? 'Του/της αρέσει να γνωρίζει νέα άτομα' : people === 'Λίγα, οκ' ? 'Δέχεται λίγα νέα άτομα στην παρέα' : 'Προτιμά την κλειστή παρέα, χωρίς νέα άτομα', domain: 'social', polarity: people === 'Προτιμώ τους δικούς μας' ? 'avoids' : 'likes', strength: 0.5, keywords: ['γνωριμίες', 'νέα άτομα', 'κόσμος'], quote: people }));

  const style = text('decide_style');
  if (style) out.push(draft({ kind: 'decision_pattern', statement: `Όταν η παρέα διαφωνεί: ${style.toLowerCase()}`, domain: 'social', polarity: 'neutral', strength: style.startsWith('Αν δεν') ? 0.9 : 0.6, quote: style }));

  return out;
}

export interface OnboardBody {
  name: string;
  emoji: string;
  answers: Answers;
  holdouts: { question: string; options: { title: string; cost: number | null }[]; chosen: number; why: string }[];
}
