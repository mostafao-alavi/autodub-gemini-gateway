# AutoDub Gemini Gateway (Cloudflare Worker + US Durable Object)

پروکسی سبک و تمام‌دوطرفه (HTTP REST + WebSocket `BidiGenerateContent`) برای سرویس‌های Google Gemini روی **Cloudflare Workers** همراه با **Durable Object پین‌شده در غرب آمریکا (`locationHint: "wnam"`)**.

## ویژگی‌های کلیدی
- **BYOK Passthrough:** کلید شخصی کاربران روی سرور ذخیره نمی‌شود، اما درخواست‌های بدون کلید پیش از ورود به Durable Object در لبه کلادفلر با کد `401` رد می‌شوند.
- **پشتیبانی کامل از Gemini Live API (WebSocket):** فوروارد دوطرفه جریان صوتی PCM با `WebSocketPair` و نگاشت امن کدهای بسته‌شدن (`1005/1006/1015`).
- **پالایش هدرها و پین جغرافیایی به آمریکا:** هدرهای `Origin`, `Referer`, `CF-Connecting-IP`, `CF-IPCountry`, `X-Forwarded-For` حذف می‌شوند تا درخواست‌ها از دیتاسنتر آمریکا (`wnam`, تقسیم‌شده به ۸ شارد) به گوگل برسند.
- **محافظت در برابر سوءاستفاده:** Allowlist مسیرهای رسمی جمنای (`/v1beta/`, `/v1alpha/`, `/ws/google.ai.generativelanguage.`) + محدودیت نرخ (`120` درخواست در هر ۶۰ ثانیه به‌ازای IP و پیشوند کلید).

---

## ۱. پوش کردن روی GitHub

این پوشه به‌عنوان یک مخزن مستقل Git آماده شده است. برای ارسال به گیتهاب:

```bash
cd cloudflare-gemini-proxy
git branch -M main
git remote add origin https://github.com/<USERNAME>/<REPO_NAME>.git
git push -u origin main
```

---

## ۲. دیپلوی روی Cloudflare و اتصال به دامنه اختصاصی (Custom Domain)

### روش A: اتصال مستقیم گیتهاب در داشبورد کلادفلر (پیشنهادی، بدون نیاز به تنظیم Token)
1. وارد داشبورد **Cloudflare** شوید ← بخش **Workers & Pages** ← دکمه **Create** ← تب **Workers** ← **Import a repository** را بزنید.
2. مخزن گیتهاب خود را انتخاب کنید؛ کلادفلر به‌صورت خودکار فایل `wrangler.toml` را می‌خواند و با دستور `npx wrangler deploy` ورکر `autodub-gemini-gateway` را منتشر می‌کند.
3. بعد از دیپلوی، یک آدرس پیش‌فرض `https://autodub-gemini-gateway.<subdomain>.workers.dev` دریافت می‌کنید.

### روش B: اتصال دامنه اختصاصی (Custom Domain) — توصیه‌شده برای ثبات در ایران
زیردامنه‌های عمومی `*.workers.dev` گاهی روی برخی ISPها دچار اختلال هستند؛ حتماً یک زیردامنه شخصی خودتان (که DNS آن روی Cloudflare است) را متصل کنید:

1. در داشبورد کلادفلر روی ورکر `autodub-gemini-gateway` بروید ← **Settings** ← **Domains & Routes** ← **Add** ← **Custom Domain**.
2. مثلاً `gemini.yourdomain.com` را وارد کنید و **Add Custom Domain** را بزنید (کلادفلر به‌طور خودکار رکورد DNS و گواهی SSL را می‌سازد).
3. یا اگر با Wrangler دیپلوی می‌کنید، بخش `routes` را در `wrangler.toml` از حالت کامنت خارج کنید:
   ```toml
   routes = [
     { pattern = "gemini.yourdomain.com", custom_domain = true }
   ]
   ```
4. در تنظیمات SSL/TLS دامنه روی Cloudflare، حالت را روی **Full (strict)** و در بخش **Network** گزینه **WebSockets** را روی **On** بگذارید.

### روش C: دیپلوی خودکار با GitHub Actions
اگر مایل به استفاده از GitHub Actions هستید، فایل آماده `docs/github-actions-deploy.example.yml` را به `.github/workflows/deploy.yml` کپی کنید و در ریپوی گیتهاب، مسیر **Settings → Secrets and variables → Actions** را باز کرده و این دو Secret را اضافه کنید:
- `CLOUDFLARE_API_TOKEN` (با دسترسی *Edit Cloudflare Workers*)
- `CLOUDFLARE_ACCOUNT_ID`

---

## ۳. تست سلامت و اتصال به افزونه AutoDub Live

پس از دیپلوی، در مرورگر یا ترمینال آدرس زیر را باز کنید:
```text
https://gemini.yourdomain.com/health
```
باید پاسخ JSON مشابه زیر بگیرید:
```json
{
  "ok": true,
  "service": "autodub-gemini-gateway",
  "locationHint": "wnam",
  "shards": 8
}
```
سپس در پنجره افزونه **AutoDub Live**، مسیر اتصال را روی **«واسطه Cloudflare Worker»** بگذارید و `https://gemini.yourdomain.com` را وارد و تست کنید.

---

## اجرای تست‌های محلی
```bash
npm test
```
