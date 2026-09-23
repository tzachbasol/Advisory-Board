import React, { useEffect, useState } from 'react';
import { KeyRound, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { ApiError, UserRow, deleteUser, listUsers, saveUser } from '@/lib/api';
import { formatWhen } from '@/lib/history';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  onUnauthorized: () => void;
}

export const UsersDialog = ({ open, onOpenChange, token, onUnauthorized }: Props) => {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) onUnauthorized();
    toast.error(err instanceof Error ? err.message : 'הפעולה נכשלה.');
  };

  const refresh = () =>
    listUsers(token)
      .then((r) => setUsers(r.users.sort((a, b) => a.username.localeCompare(b.username))))
      .catch(fail);

  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = username.trim().toLowerCase();
    const exists = users?.some((u) => u.username === name);
    setBusy(true);
    try {
      await saveUser(token, name, password);
      toast.success(exists ? `הסיסמה של ${name} עודכנה` : `המשתמש ${name} נוצר`);
      setUsername('');
      setPassword('');
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`למחוק את המשתמש ${name}? הוא לא יוכל להתחבר יותר.`)) return;
    try {
      await deleteUser(token, name);
      toast.success(`המשתמש ${name} נמחק`);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="text-right max-h-[90vh] overflow-y-auto">
        <DialogHeader className="text-right sm:text-right">
          <DialogTitle>ניהול משתמשים</DialogTitle>
          <DialogDescription>
            כל משתמש מתחבר עם שם וסיסמה, והשימוש שלו נספר על המפתח שלך. הזנת שם של משתמש קיים מחליפה את הסיסמה שלו.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="new-username">שם משתמש</Label>
            <Input
              id="new-username"
              dir="ltr"
              autoCapitalize="none"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-password">סיסמה (6 תווים לפחות)</Label>
            <Input
              id="new-password"
              dir="ltr"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4 ml-1" />}
            שמור
          </Button>
        </form>

        <div className="space-y-1 mt-2">
          {users === null && <p className="text-sm text-muted-foreground">טוען...</p>}
          {users?.length === 0 && <p className="text-sm text-muted-foreground">עוד אין משתמשים. צור את הראשון למעלה.</p>}
          {users?.map((u) => (
            <div key={u.username} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <div>
                <div className="font-medium" dir="ltr">
                  {u.username}
                </div>
                <div className="text-xs text-muted-foreground">
                  נוצר <bdi dir="ltr">{formatWhen(u.createdAt)}</bdi>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => remove(u.username)} aria-label={`מחק את ${u.username}`}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};
