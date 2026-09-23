# מועצת היועצים

כותבים התלבטות או שאלה (אפשר לצרף צילום מסך, תמונה, PDF, Word, Excel או קובץ טקסט), ושבעה יועצים מבוססי Claude עונים במקביל - כל אחד מנקודת מבט אחרת, ובסוף כל תשובה שורה תחתונה עם המלצה.

| יועץ | נקודת המבט |
|---|---|
| 🛡️ הפסימי | מה הכי בטוח, ולמה לא ללכת על משהו נועז |
| ☀️ האופטימי | הדרך המקובלת, מהצד החיובי |
| 🚀 היוזם | מהלך יצירתי מחוץ לקופסה |
| ❓ השואל חזרה | שאלה חכמה לשאול חזרה לפני שעונים |
| 🎯 המנהל | התשובה הסמכותית, קרת הרוח והאסטרטגית |
| 🔧 הפרקטי | מה תכל׳ס לעשות, בקצרה |
| 🤝 המשא ומתן | אלטרנטיבות, פשרות, קווים אדומים ופתרונות ביניים |

## שימוש

- האתר: https://tzachbasol.github.io/Advisory-Board/
- מתחברים עם שם משתמש וסיסמה. המנהל (`admin`) יוצר משתמשים דרך כפתור "משתמשים".
- מפתח ה-API של Anthropic שמור רק בשרת (Cloudflare Worker), ולא מגיע אף פעם לדפדפן.
- היסטוריית השאלות (עם תאריך ושעה) נשמרת בדפדפן שבו השתמשת.
- אפשר לעצור ריצה באמצע, לכבות יועצים מסוימים ולבחור מודל.

## מבנה

- `src/` - האתר (React + Vite), מתפרסם ב-GitHub Pages.
- `worker/` - השרת (Cloudflare Worker): התחברות, ניהול משתמשים, והעברת השאלות ל-Claude עם המפתח.

## הגדרה חד-פעמית

ב-GitHub: Settings → Secrets and variables → Actions → New repository secret:

| שם | מה לשים |
|---|---|
| `ANTHROPIC_API_KEY` | מפתח API מ-console.anthropic.com |
| `ADMIN_PASSWORD` | הסיסמה של משתמש המנהל `admin` |
| `CLOUDFLARE_API_TOKEN` | טוקן מ-Cloudflare עם התבנית "Edit Cloudflare Workers" |
| `CLOUDFLARE_ACCOUNT_ID` | מזהה החשבון ב-Cloudflare (מופיע בדף Workers & Pages) |

כל דחיפה ל-`main` מפרסמת את השרת ואת האתר (`.github/workflows/deploy-pages.yml`).

## פיתוח

```sh
npm install && (cd worker && npm install)
# worker/.dev.vars: ANTHROPIC_API_KEY=... ו-ADMIN_PASSWORD=...
(cd worker && npm run dev)            # http://127.0.0.1:8787
VITE_API_URL=http://127.0.0.1:8787 npm run dev
```
