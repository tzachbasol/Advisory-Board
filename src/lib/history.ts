import type { AdvisorId } from './advisors';
import type { Attachment } from './claude';

export interface Reply {
  text: string;
  status: 'streaming' | 'done' | 'error';
  error?: string;
  /** The user stopped the run before this advisor finished. */
  stopped?: boolean;
}

export interface Turn {
  id: string;
  /** When the question was asked (ms since epoch). */
  at: number;
  text: string;
  attachments: Attachment[];
  advisorIds: AdvisorId[];
  replies: Partial<Record<AdvisorId, Reply>>;
}

export interface Conversation {
  id: string;
  updatedAt: number;
  turns: Turn[];
}

/** crypto.randomUUID needs a secure context; fall back so the page never crashes over an id. */
export const newId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const KEY = 'advisors.history';
const MAX_CONVERSATIONS = 200;
/** Text files are kept in history up to this many characters, so follow-ups still see them. */
const MAX_SAVED_FILE_CHARS = 20000;

export const loadHistory = (): Conversation[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** Strip what's too heavy for browser storage: images and PDFs are kept by name only. */
const slim = (conversation: Conversation): Conversation => ({
  ...conversation,
  turns: conversation.turns.map((turn) => ({
    ...turn,
    attachments: turn.attachments.map((a): Attachment =>
      a.kind === 'text'
        ? { ...a, text: a.text.slice(0, MAX_SAVED_FILE_CHARS) }
        : { kind: 'missing', name: a.name },
    ),
    replies: Object.fromEntries(
      Object.entries(turn.replies).map(([id, r]) => [id, r?.status === 'streaming' ? { ...r, status: 'done' } : r]),
    ),
  })),
});

/** Saves the list newest-first; drops the oldest conversations if the browser runs out of room. */
export const saveHistory = (conversations: Conversation[]) => {
  let list = conversations.slice(0, MAX_CONVERSATIONS).map(slim);
  while (list.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return;
    } catch {
      list = list.slice(0, -1);
    }
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable - history just won't persist
  }
};

export const formatWhen = (at: number) =>
  new Date(at).toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
