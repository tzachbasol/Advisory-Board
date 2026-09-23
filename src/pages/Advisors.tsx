import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Camera, FileText, History, Loader2, Paperclip, Plus, Send, Settings, Square, Trash2, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { ADVISORS, Advisor, AdvisorId, systemPromptFor, splitBottomLine } from '@/lib/advisors';
import {
  Attachment,
  DEFAULT_MODEL,
  MODELS,
  ModelId,
  buildUserContent,
  createClient,
  describeError,
  fileToAttachment,
  streamAdvisor,
} from '@/lib/claude';
import { Conversation, Reply, Turn, formatWhen, loadHistory, newId, saveHistory } from '@/lib/history';

const STORAGE_KEYS = { apiKey: 'advisors.apiKey', model: 'advisors.model', active: 'advisors.active' };

const load = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode etc.) - settings just won't persist
  }
};

/** Minimal markdown: **bold** and "- " bullets. */
const RichText = ({ text }: { text: string }) => (
  <>
    {text.split('\n').map((line, i) => {
      const bullet = /^\s*[-*•]\s+/.test(line);
      const content = line.replace(/^\s*[-*•]\s+/, '');
      const parts = content.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
        part.startsWith('**') && part.endsWith('**') ? <strong key={j}>{part.slice(2, -2)}</strong> : part,
      );
      if (!line.trim()) return <div key={i} className="h-2" />;
      return bullet ? (
        <div key={i} className="flex gap-2">
          <span className="text-muted-foreground">•</span>
          <span>{parts}</span>
        </div>
      ) : (
        <p key={i}>{parts}</p>
      );
    })}
  </>
);

const AdvisorCard = ({ advisor, reply }: { advisor: Advisor; reply?: Reply }) => {
  const { analysis, bottomLine } = splitBottomLine(reply?.text ?? '');
  return (
    <Card className={cn('border-t-4 flex flex-col', advisor.accent)}>
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xl" aria-hidden>
              {advisor.emoji}
            </span>
            <span className="font-semibold">{advisor.name}</span>
          </div>
          <span className={cn('text-xs rounded-full px-2 py-0.5', advisor.badge)}>{advisor.tagline}</span>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 flex-1 flex flex-col gap-3 text-sm leading-relaxed">
        {reply?.status === 'error' ? (
          <p className="text-destructive">{reply.error}</p>
        ) : !reply?.text ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> חושב...
          </div>
        ) : (
          <>
            <div className="space-y-1 text-foreground/90">
              <RichText text={analysis} />
            </div>
            {bottomLine && (
              <div className="mt-auto rounded-md bg-muted p-3">
                <div className="text-xs font-semibold text-muted-foreground mb-1">שורה תחתונה</div>
                <div className="font-medium">
                  <RichText text={bottomLine} />
                </div>
              </div>
            )}
            {reply.status === 'streaming' && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
            {reply.stopped && <p className="text-xs text-muted-foreground">נעצר באמצע</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
};

const AttachmentChip = ({ attachment, onRemove }: { attachment: Attachment; onRemove?: () => void }) => (
  <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs max-w-[220px]">
    {attachment.kind === 'image' ? (
      <img src={attachment.previewUrl} alt="" className="h-8 w-8 rounded object-cover" />
    ) : attachment.kind === 'pdf' ? (
      <FileText className="h-4 w-4 text-red-600 shrink-0" />
    ) : (
      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
    )}
    <span className="truncate">{attachment.name}</span>
    {onRemove && (
      <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-foreground" aria-label="הסר">
        <X className="h-3 w-3" />
      </button>
    )}
  </div>
);

const Advisors = () => {
  const [apiKey, setApiKey] = useState(() => load(STORAGE_KEYS.apiKey) ?? '');
  const [model, setModel] = useState<ModelId>(() => {
    const stored = load(STORAGE_KEYS.model);
    return MODELS.some((m) => m.id === stored) ? (stored as ModelId) : DEFAULT_MODEL;
  });
  const [active, setActive] = useState<AdvisorId[]>(() => {
    try {
      const stored = JSON.parse(load(STORAGE_KEYS.active) ?? 'null');
      if (Array.isArray(stored) && stored.length) return ADVISORS.map((a) => a.id).filter((id) => stored.includes(id));
    } catch {
      // ignore malformed value
    }
    return ADVISORS.map((a) => a.id);
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftKey, setDraftKey] = useState(apiKey);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [conversationId, setConversationId] = useState<string>(() => newId());
  const [history, setHistory] = useState<Conversation[]>(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);

  const busy = turns.some((t) => Object.values(t.replies).some((r) => r?.status === 'streaming'));

  useEffect(() => save(STORAGE_KEYS.active, JSON.stringify(active)), [active]);
  useEffect(() => save(STORAGE_KEYS.model, model), [model]);
  useEffect(() => {
    if (!scrollTarget) return;
    const target = scrollTarget === 'bottom' ? bottomRef.current : document.getElementById(`turn-${scrollTarget}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setScrollTarget(null);
  }, [scrollTarget, turns.length]);

  const persist = (id: string, list: Turn[]) =>
    setHistory((prev) => {
      const next = [{ id, updatedAt: Date.now(), turns: list }, ...prev.filter((c) => c.id !== id)];
      saveHistory(next);
      return next;
    });

  // Save the conversation once every advisor has finished (or was stopped).
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && turns.length) persist(conversationId, turns);
    wasBusy.current = busy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const startNewConversation = () => {
    setTurns([]);
    setConversationId(newId());
  };

  const openConversation = (conversation: Conversation, turnId: string) => {
    setTurns(conversation.turns);
    setConversationId(conversation.id);
    setHistoryOpen(false);
    setScrollTarget(turnId);
  };

  const deleteConversation = (id: string) => {
    if (!window.confirm('למחוק את השיחה הזו מההיסטוריה?')) return;
    setHistory((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveHistory(next);
      return next;
    });
    if (id === conversationId) startNewConversation();
  };

  const clearHistory = () => {
    if (!window.confirm('למחוק את כל ההיסטוריה? אי אפשר לשחזר.')) return;
    setHistory([]);
    saveHistory([]);
  };

  const pastQuestions = useMemo(
    () =>
      history
        .flatMap((conversation) => conversation.turns.map((turn) => ({ conversation, turn })))
        .sort((a, b) => b.turn.at - a.turn.at),
    [history],
  );

  const client = useMemo(() => (apiKey ? createClient(apiKey) : null), [apiKey]);

  const addFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        const attachment = await fileToAttachment(file);
        setAttachments((prev) => [...prev, attachment]);
      } catch (error) {
        toast.error(describeError(error));
      }
    }
  };

  const toggleAdvisor = (id: AdvisorId) =>
    setActive((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : ADVISORS.map((a) => a.id).filter((x) => x === id || prev.includes(x)),
    );

  const updateReply = (turnId: string, advisorId: AdvisorId, update: (r: Reply) => Reply) =>
    setTurns((prev) =>
      prev.map((t) =>
        t.id === turnId
          ? { ...t, replies: { ...t.replies, [advisorId]: update(t.replies[advisorId] ?? { text: '', status: 'streaming' }) } }
          : t,
      ),
    );

  const historyFor = (advisorId: AdvisorId, turn: Turn): BetaMessageParam[] => {
    const messages: BetaMessageParam[] = [];
    for (const t of [...turns, turn]) {
      messages.push({ role: 'user', content: buildUserContent(t.text, t.attachments) });
      const reply = t.replies[advisorId];
      if (t !== turn && reply?.status === 'done' && reply.text) {
        messages.push({ role: 'assistant', content: reply.text });
      }
    }
    return messages;
  };

  const send = () => {
    if (busy) return;
    if (!text.trim() && !attachments.length) return;
    if (!client) {
      setDraftKey(apiKey);
      setSettingsOpen(true);
      return;
    }
    if (!active.length) {
      toast.error('בחר לפחות יועץ אחד');
      return;
    }

    const turn: Turn = {
      id: newId(),
      at: Date.now(),
      text: text.trim(),
      attachments,
      advisorIds: active,
      replies: Object.fromEntries(active.map((id) => [id, { text: '', status: 'streaming' as const }])),
    };
    const controller = new AbortController();
    abortRef.current = controller;
    setTurns((prev) => [...prev, turn]);
    persist(conversationId, [...turns, turn]);
    setScrollTarget(turn.id);
    setText('');
    setAttachments([]);

    for (const advisor of ADVISORS.filter((a) => turn.advisorIds.includes(a.id))) {
      streamAdvisor({
        client,
        model,
        system: systemPromptFor(advisor),
        messages: historyFor(advisor.id, turn),
        signal: controller.signal,
        onText: (delta) => updateReply(turn.id, advisor.id, (r) => ({ ...r, text: r.text + delta })),
      })
        .then((final) => updateReply(turn.id, advisor.id, () => ({ text: final, status: 'done' })))
        .catch((error) =>
          updateReply(turn.id, advisor.id, (r) =>
            controller.signal.aborted
              ? r.text
                ? { ...r, status: 'done', stopped: true }
                : { ...r, status: 'error', error: 'נעצר לפני שהספיק לענות', stopped: true }
              : { ...r, status: 'error', error: describeError(error) },
          ),
        );
    }
  };

  const saveSettings = () => {
    const key = draftKey.trim();
    setApiKey(key);
    save(STORAGE_KEYS.apiKey, key);
    setSettingsOpen(false);
  };

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-50 flex flex-col">
      <header className="bg-white shadow-sm border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Users className="h-8 w-8 text-indigo-600" />
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">מועצת היועצים</h1>
              <p className="text-xs sm:text-sm text-gray-600">שבע נקודות מבט על כל שאלה - וכל אחת עם שורה תחתונה</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)} aria-label="היסטוריה">
              <History className="h-4 w-4 sm:ml-1" />
              <span className="hidden sm:inline">היסטוריה</span>
            </Button>
            {turns.length > 0 && (
              <Button variant="outline" size="sm" onClick={startNewConversation} disabled={busy} aria-label="שיחה חדשה">
                <Plus className="h-4 w-4 sm:ml-1" />
                <span className="hidden sm:inline">שיחה חדשה</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                setDraftKey(apiKey);
                setSettingsOpen(true);
              }}
              aria-label="הגדרות"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-8">
        {!apiKey && (
          <Card className="border-amber-300 bg-amber-50">
            <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>כדי שהיועצים יענו, צריך להזין מפתח API של Anthropic (נשמר רק בדפדפן שלך).</span>
              <Button size="sm" onClick={() => setSettingsOpen(true)}>
                הזן מפתח
              </Button>
            </CardContent>
          </Card>
        )}

        {turns.length === 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {ADVISORS.map((a) => (
              <div key={a.id} className={cn('rounded-lg border border-t-4 bg-white p-3', a.accent)}>
                <div className="flex items-center gap-2 font-semibold">
                  <span aria-hidden>{a.emoji}</span> {a.name}
                </div>
                <div className="text-xs text-muted-foreground mt-1">{a.tagline}</div>
              </div>
            ))}
            <div className="rounded-lg border border-dashed bg-white/60 p-3 text-sm text-muted-foreground flex items-center">
              הדבק טקסט, צרף צילום מסך או קובץ, ושאל - כל יועץ יענה מהזווית שלו.
            </div>
          </div>
        )}

        {turns.map((turn) => {
          const running = Object.values(turn.replies).some((r) => r?.status === 'streaming');
          return (
          <section key={turn.id} id={`turn-${turn.id}`} className="space-y-4 scroll-mt-28">
            <div className="flex flex-wrap items-end justify-start gap-3">
              <div className="max-w-3xl rounded-2xl bg-indigo-600 text-white px-4 py-3 shadow-sm space-y-2">
                <div className="text-[11px] text-indigo-200">
                  <bdi dir="ltr">{formatWhen(turn.at)}</bdi>
                </div>
                {turn.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 text-foreground">
                    {turn.attachments.map((a, i) => (
                      <AttachmentChip key={i} attachment={a} />
                    ))}
                  </div>
                )}
                {turn.text && <p className="whitespace-pre-wrap text-sm">{turn.text}</p>}
              </div>
              {running && (
                <Button variant="outline" size="sm" onClick={() => abortRef.current?.abort()}>
                  <Square className="h-3.5 w-3.5 ml-1 fill-current" /> עצור ריצה
                </Button>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {ADVISORS.filter((a) => turn.advisorIds.includes(a.id)).map((advisor) => (
                <AdvisorCard key={advisor.id} advisor={advisor} reply={turn.replies[advisor.id]} />
              ))}
            </div>
          </section>
          );
        })}
        <div ref={bottomRef} />
      </main>

      <div className="sticky bottom-0 border-t bg-white/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {ADVISORS.map((a) => {
              const on = active.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => toggleAdvisor(a.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    on ? a.badge + ' border-transparent' : 'bg-background text-muted-foreground line-through',
                  )}
                  aria-pressed={on}
                >
                  {a.emoji} {a.name}
                </button>
              );
            })}
          </div>

          <div
            className={cn('rounded-lg border bg-background p-2 space-y-2', dragging && 'ring-2 ring-indigo-400')}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
            }}
          >
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <AttachmentChip
                    key={i}
                    attachment={a}
                    onRemove={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
            )}
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={turns.length ? 'שאלת המשך...' : 'תאר את המצב ושאל שאלה. אפשר להדביק צילום מסך או לגרור קובץ לכאן.'}
              className="min-h-[70px] max-h-60 border-0 focus-visible:ring-0 resize-none shadow-none"
            />
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  accept="image/*,application/pdf,.pdf,.docx,.xlsx,text/*,.md,.csv,.json,.txt"
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={photoInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  accept="image/*"
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <Button variant="ghost" size="sm" onClick={() => photoInputRef.current?.click()}>
                  <Camera className="h-4 w-4 ml-1" /> תמונה
                </Button>
                <Button variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip className="h-4 w-4 ml-1" /> צרף קובץ
                </Button>
                <span className="hidden md:inline text-xs text-muted-foreground">PDF · Word · Excel · טקסט</span>
              </div>
              {busy ? (
                <Button variant="destructive" size="sm" onClick={() => abortRef.current?.abort()}>
                  <Square className="h-4 w-4 ml-1 fill-current" /> עצור
                </Button>
              ) : (
                <Button size="sm" onClick={send} disabled={!text.trim() && !attachments.length}>
                  <Send className="h-4 w-4 ml-1 -scale-x-100" /> התייעץ
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" dir="rtl" className="w-full sm:max-w-md flex flex-col text-right">
          <SheetHeader className="text-right sm:text-right">
            <SheetTitle>היסטוריית שאלות</SheetTitle>
            <SheetDescription>נשמרת רק בדפדפן הזה. לחיצה על שאלה פותחת את השיחה שלה.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto -mx-6 px-6 mt-4 space-y-1">
            {pastQuestions.length === 0 && <p className="text-sm text-muted-foreground">עוד אין שאלות שמורות.</p>}
            {pastQuestions.map(({ conversation, turn }) => (
              <div key={turn.id} className="group flex items-start gap-2 rounded-md border p-3 hover:bg-muted/60">
                <button
                  type="button"
                  className="flex-1 min-w-0 text-right"
                  onClick={() => openConversation(conversation, turn.id)}
                  disabled={busy}
                >
                  <div className="text-xs text-muted-foreground tabular-nums">
                    <bdi dir="ltr">{formatWhen(turn.at)}</bdi>
                  </div>
                  <div className="text-sm line-clamp-2 break-words">
                    {turn.text || turn.attachments.map((a) => a.name).join(', ') || 'ללא טקסט'}
                  </div>
                  {conversation.turns.length > 1 && (
                    <div className="text-[11px] text-muted-foreground mt-1">
                      חלק משיחה עם {conversation.turns.length} שאלות
                    </div>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => deleteConversation(conversation.id)}
                  className="text-muted-foreground hover:text-destructive p-1"
                  aria-label="מחק שיחה"
                  title="מחק את השיחה"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          {pastQuestions.length > 0 && (
            <Button variant="ghost" size="sm" className="self-start text-destructive" onClick={clearHistory}>
              מחק את כל ההיסטוריה
            </Button>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent dir="rtl" className="text-right">
          <DialogHeader className="text-right sm:text-right">
            <DialogTitle>הגדרות</DialogTitle>
            <DialogDescription>
              המפתח נשמר רק בדפדפן הזה ונשלח ישירות ל-Anthropic. אפשר ליצור מפתח ב-console.anthropic.com.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="api-key">מפתח API של Anthropic</Label>
              <Input
                id="api-key"
                type="password"
                dir="ltr"
                placeholder="sk-ant-..."
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>מודל</Label>
              <Select value={model} onValueChange={(v) => setModel(v as ModelId)}>
                <SelectTrigger dir="rtl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent dir="rtl">
                  {MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:justify-start">
            <Button onClick={saveSettings}>שמור</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Advisors;
