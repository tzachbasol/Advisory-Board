import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

export const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 (מומלץ)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (מהיר יותר)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (הכי מהיר וזול)' },
] as const;

export type ModelId = (typeof MODELS)[number]['id'];
export const DEFAULT_MODEL: ModelId = 'claude-opus-5';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_TYPES)[number];

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|html?|ya?ml|log|js|jsx|ts|tsx|py|java|c|cpp|cs|go|rb|php|sql|sh|css|ini|toml|eml)$/i;

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type Attachment =
  | { kind: 'image'; name: string; mediaType: ImageMediaType; data: string; previewUrl: string }
  | { kind: 'pdf'; name: string; data: string }
  | { kind: 'text'; name: string; text: string; label?: string }
  /** A file from an earlier session, kept in history by name only. */
  | { kind: 'missing'; name: string };

const IMAGE_EXTENSIONS = /\.(heic|heif|jpe?g|png|webp|gif|bmp|avif)$/i;
const MAX_IMAGE_SIDE = 2400;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Phone photos can be HEIC or very large: redraw anything Claude can't take as-is into a JPEG. */
const normalizeImage = async (file: File): Promise<{ mediaType: ImageMediaType; dataUrl: string }> => {
  if ((IMAGE_TYPES as readonly string[]).includes(file.type) && file.size <= MAX_IMAGE_BYTES) {
    return { mediaType: file.type as ImageMediaType, dataUrl: await readAsDataUrl(file) };
  }
  const img = new Image();
  img.src = await readAsDataUrl(file);
  try {
    await img.decode();
  } catch {
    throw new Error(`לא הצלחתי לפתוח את התמונה "${file.name}". נסה לצלם מסך שלה ולצרף את צילום המסך.`);
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { mediaType: 'image/jpeg', dataUrl: canvas.toDataURL('image/jpeg', 0.85) };
};

const docxText = async (file: File) => {
  // The package's default entry targets Node; the browser build is a self-contained bundle.
  const { default: mammoth } = (await import('mammoth/mammoth.browser.min.js')) as { default: typeof import('mammoth') };
  return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
};

const cellText = (cell: unknown) => {
  if (cell == null) return '';
  const text = cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const sheetText = async (file: File) => {
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  const sheets = await readXlsxFile(file);
  return sheets
    .map(({ sheet, data }) => `# גיליון: ${sheet}\n` + data.map((row) => row.map(cellText).join(',')).join('\n'))
    .join('\n\n');
};

const readAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Convert a user-picked file into something Claude can read. Throws a user-facing message if unsupported. */
export const fileToAttachment = async (file: File): Promise<Attachment> => {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`הקובץ "${file.name}" גדול מ-20MB`);
  }
  if (file.type.startsWith('image/') || IMAGE_EXTENSIONS.test(file.name)) {
    const { mediaType, dataUrl } = await normalizeImage(file);
    return { kind: 'image', name: file.name || 'image', mediaType, data: dataUrl.split(',')[1] ?? '', previewUrl: dataUrl };
  }
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    return { kind: 'pdf', name: file.name, data: await readAsBase64(file) };
  }
  let text: string | null = null;
  let label = 'טקסט';
  try {
    if (/\.docx$/i.test(file.name)) {
      text = await docxText(file);
      label = 'Word';
    } else if (/\.xlsx$/i.test(file.name)) {
      text = await sheetText(file);
      label = 'Excel';
    } else if (file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXTENSIONS.test(file.name)) {
      text = await file.text();
    }
  } catch {
    throw new Error(`לא הצלחתי לקרוא את הקובץ "${file.name}".`);
  }
  if (text === null) {
    throw new Error(
      `סוג הקובץ "${file.name}" לא נתמך. אפשר לצרף תמונות, PDF, Word (docx), Excel (xlsx) או קבצי טקסט. קובץ doc/xls ישן - שמור אותו כ-docx/xlsx או כ-PDF.`,
    );
  }
  if (!text.trim()) throw new Error(`לא נמצא טקסט בקובץ "${file.name}".`);
  return { kind: 'text', name: file.name, text, label };
};

export const buildUserContent = (text: string, attachments: Attachment[]): BetaContentBlockParam[] => {
  const blocks: BetaContentBlockParam[] = [];
  for (const a of attachments) {
    if (a.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
    } else if (a.kind === 'pdf') {
      blocks.push({
        type: 'document',
        title: a.name,
        source: { type: 'base64', media_type: 'application/pdf', data: a.data },
      });
    } else if (a.kind === 'text') {
      blocks.push({ type: 'text', text: `<file name="${a.name}">\n${a.text}\n</file>` });
    } else {
      blocks.push({ type: 'text', text: `[המשתמש צירף קודם את הקובץ "${a.name}", והוא כבר לא זמין]` });
    }
  }
  blocks.push({ type: 'text', text: text.trim() || 'מה דעתך על מה שצירפתי? מה כדאי לי לעשות?' });
  return blocks;
};

export const createClient = (apiKey: string) =>
  // The key is supplied by the user and stays in their browser.
  new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

export interface StreamAdvisorOptions {
  client: Anthropic;
  model: ModelId;
  system: string;
  messages: BetaMessageParam[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}

/** Streams one advisor's answer. Resolves with the final text; throws on API errors or refusals. */
export const streamAdvisor = async ({ client, model, system, messages, signal, onText }: StreamAdvisorOptions) => {
  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: 16000,
      system,
      messages,
      // On Opus 5 a declined request is re-run server-side on Anthropic's recommended fallback model.
      ...(model === 'claude-opus-5'
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
    },
    { signal },
  );
  stream.on('text', onText);
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new Error('היועץ סירב לענות על הבקשה הזו.');
  }
  return message.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
};

export const describeError = (error: unknown): string => {
  if (error instanceof Anthropic.AuthenticationError) return 'מפתח ה-API לא תקין. בדוק אותו בהגדרות.';
  if (error instanceof Anthropic.PermissionDeniedError) return 'למפתח הזה אין הרשאה למודל שנבחר.';
  if (error instanceof Anthropic.RateLimitError) return 'חריגה ממגבלת הקצב - נסה שוב בעוד רגע.';
  if (error instanceof Anthropic.BadRequestError) return `בקשה לא תקינה: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return 'אין חיבור ל-Claude. בדוק את החיבור לאינטרנט.';
  if (error instanceof Anthropic.APIError) return `שגיאת API (${error.status}): ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'שגיאה לא ידועה';
};
