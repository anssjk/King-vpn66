# تغییرات — آدرس و توکن پنل در زمان اجرا (v1.9.5)

## چه چیزی عوض شد

تا نسخه‌ی قبل، آدرس پنل در **زمان بیلد** داخل اپ قرار می‌گرفت (`EXPO_PUBLIC_API_URL`). یعنی هر
تغییر آدرس یا توکن، یک بیلد جدید لازم داشت و یک APK فقط برای یک پنل کار می‌کرد.

از این نسخه، **هیچ آدرسی در اپ نیست**. کاربر در اولین اجرا آدرس پنل و توکن خودش را وارد
می‌کند، هر دو روی گوشی ذخیره می‌شوند، و همه‌ی درخواست‌ها با همان‌ها انجام می‌شود.

## فایل‌های عوض‌شده

| فایل | تغییر |
|---|---|
| `src/lib/config.ts` | بازنویسی: `PanelConfig`، `normalizeBaseUrl`، `isValidBaseUrl`، `isValidToken`، `isPanelConfigured`، `tokenPageUrl`. دیگر `EXPO_PUBLIC_API_URL` خوانده نمی‌شود. |
| `src/lib/panel-context.tsx` | **جدید**: نگه‌داشتن آدرس و توکن روی دستگاه (`usePersistentState('panel')`) + `save` / `clear`. |
| `src/lib/api.ts` | بازنویسی: هر تابع پنل را به‌عنوان پارامتر می‌گیرد (`verifyToken(panel)`، `fetchServers(panel)`)، به‌علاوه‌ی `testPanel` برای صفحه‌ی راه‌اندازی. `createToken` حذف شد. |
| `src/app/setup.tsx` | **جدید**: صفحه‌ی اولین اجرا — آدرس + توکن، اعتبارسنجی، تست اتصال، ذخیره. با `?edit=1` از تنظیمات هم باز می‌شود. |
| `src/app/index.tsx` | اگر پنل تنظیم نشده باشد به `/setup` می‌رود، وگرنه به `/(tabs)`. |
| `src/app/_layout.tsx` | `PanelProvider` اضافه شد و مسیر `setup` ثبت شد. |
| `src/lib/app-context.tsx` | `token`/`ensureToken`/`refreshToken`/`tokenError` حذف شدند؛ جایش `panelConfigured` آمد. سرورها از پنلِ کاربر خوانده می‌شوند. |
| `src/app/(tabs)/settings.tsx` | بخش «اتصال به پنل»: نمایش آدرس و توکن (ماسک‌شده)، دکمه‌ی تغییر، به‌روزرسانی، صفحه‌ی توکن، و پاک کردن پنل با تأیید. |
| `src/components/home-panel.tsx` | اگر پنل تنظیم نشده باشد، کارت «تنظیم پنل» نشان می‌دهد. |
| `src/lib/i18n.ts` | رشته‌های جدید فارسی/انگلیسی برای صفحه‌ی راه‌اندازی و بخش پنل. |
| `.github/workflows/build-apk.yml` | ورودی `api_url` و متغیر `EXPO_PUBLIC_API_URL` حذف شدند. |
| `.env.example` | دیگر لازم نیست؛ توضیح داده شده که هیچ متغیری نباید بگذارید. |
| `BUILD_GUIDE.md` / `GITHUB_ACTIONS_GUIDE.md` / `README.md` / `server/README.md` | بخش آدرس پنل به‌روز شد. |

## نتیجه

- یک APK برای همه‌ی کاربران؛ هر کس آدرس و توکن خودش را وارد می‌کند.
- تغییر دامنه یا توکن، **بدون بیلد جدید**.
- هیچ Secretی برای بیلد لازم نیست.

---

# تغییرات — رفع خطای build (v1.9.3)

## خطای دیده‌شده

در GitHub Actions، مرحله‌ی **Build the APK** بعد از حدود ۱۳ دقیقه شکست:

```
... 72 more
BUILD FAILED in 12m 31s
579 actionable tasks: 579 executed
Error: Process completed with exit code 1.
```

انتهای stack trace:

```
org.gradle.util.internal.DeferredUtil.unpack(DeferredUtil.java:57)
org.gradle.util.internal.DeferredUtil.unpackOrNull(DeferredUtil.java:49)
org.gradle.api.internal.tasks.properties.InputParameterUtils.prepareInputParameterValue(...)
```

## علت دقیق

این stack trace یعنی: **Gradle موقع «عکس‌برداری از ورودی‌های یک task» یک مقدار lazy را باز کرد و آن مقدار throw کرد یا null بود.** پیام اصلی AGP بیرون کادر عکس بود، پس ریشه را در سورس پیدا کردیم.

ریشه در `modules/king-vpn-tunnel/android/build.gradle` بود:

```groovy
defaultConfig {
  ndk {
    abiFilters 'arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'
  }
}
```

وقتی یک **ماژول library** بلوک `ndk { abiFilters ... }` دارد، AGP آن را «ماژول با کانفیگ نیتیو» حساب می‌کند و برایش task های نیتیو می‌سازد — از جمله `stripReleaseDebugSymbols` و `mergeReleaseNativeLibs`. این task ها مسیر NDK را **lazy** resolve می‌کنند، دقیقاً در همان لحظه‌ای که Gradle ورودی‌های task را snapshot می‌کند.

و این ماژول **هیچ کد نیتیو کامپایل نمی‌کند** — فقط دو `.so` آماده از دو AAR داخلش می‌آید. پس:

1. ماژول `ndkVersion` نداشت،
2. AGP به NDK پیش‌فرض خودش برمی‌گشت (نه نسخه‌ای که ریشه‌ی پروژه پین کرده: `27.1.12297006`)،
3. آن نسخه روی runner نصب نبود،
4. provider مربوط به NDK موقع snapshot ورودی‌ها throw کرد،
5. نتیجه: همان stack trace بی‌پیام `DeferredUtil.unpack` و `exit code 1`.

## اصلاح

### ۱) `modules/king-vpn-tunnel/android/build.gradle`

- **حذف بلوک `ndk { abiFilters ... }`** — این ماژول کد نیتیو ندارد، پس اصلاً به NDK نیاز ندارد. با حذف آن، AGP دیگر برای این ماژول task نیتیو نمی‌سازد و آن provider lazy هرگز اجرا نمی‌شود. (این ABI ها در APK از `reactNativeArchitectures` در ماژول app می‌آیند، نه از اینجا.)
- **پین کردن `ndkVersion` به نسخه‌ی ریشه‌ی پروژه**:
  ```groovy
  if (rootProject.ext.has('ndkVersion')) {
    ndkVersion rootProject.ext.ndkVersion
  }
  ```
  تا اگر AGP به هر دلیلی NDK خواست، همان نسخه‌ی پین‌شده‌ی RN/Expo را بخواهد، نه پیش‌فرض خودش.

### ۲) `.github/workflows/build-apk.yml`

یک step جدید **«Install the pinned Android NDK»** اضافه شد که نسخه‌ی `27.1.12297006` (همان نسخه‌ای که RN 0.86 / Expo SDK 57 پین می‌کند) را با `sdkmanager` نصب می‌کند. اگر از قبل نصب باشد، رد می‌شود. این کار کل این دسته خطا را از بین می‌برد.

### ۳) نسخه

`app.json` → `version: 1.9.3`، `versionCode: 14`؛ `package.json` → `1.9.3`.

## چرا این بار آن خطا تکرار نمی‌شود

- **محرک حذف شد:** بدون `abiFilters`، ماژول `king-vpn-tunnel` دیگر task نیتیو ندارد؛ پس `stripReleaseDebugSymbols` برای آن اجرا نمی‌شود و آن provider lazy که throw می‌کرد، هرگز صدا زده نمی‌شود.
- **اگر باز هم NDK لازم شد:** هم ماژول به نسخه‌ی ریشه پین شده، هم ورکفلو همان نسخه را از قبل نصب می‌کند. پس «NDK پیدا نشد» دیگر ممکن نیست.
- **خطا دیگر بلعیده نمی‌شود:** `--stacktrace` هست و هیچ `||` و fallback به debug وجود ندارد؛ اگر چیز دیگری بشکند، پیام واقعی AGP در لاگ دیده می‌شود.

## اصلاحات قبلی که دست‌نخورده ماندند

- بدون `|| ./gradlew assembleDebug` — فقط `./gradlew assembleRelease --no-daemon --stacktrace`
- `EXPO_PUBLIC_API_URL: ${{ secrets.EXPO_PUBLIC_API_URL }}` در step های prebuild و build
- بدون `--non-interactive` در `expo prebuild`
- `npm ci --no-audit --no-fund || npm install --no-audit --no-fund`
- step «Configure Gradle memory» با `org.gradle.jvmargs=-Xmx4g` در `android/gradle.properties`
- `minSdkVersion: 29` از طریق `expo-build-properties` در `app.json`

## تست‌شده در همین محیط

- `npm ci` → ۵۸۹ پکیج، بدون خطا
- `npx tsc --noEmit` → ۰ خطا
- `npx expo install --check` → `Dependencies are up to date`
- `npx expo config --type prebuild --json` → exit 0، `versionCode: 14`، هر ۴ پلاگین حاضر
- `npx expo export --platform android` → باندل JS کامپایل شد (exit 0)
- اعتبار YAML ورکفلو → ۱۳ step، همه‌ی ۵ شرط حفظ‌شده
- هش SHA-256 هر دو AAR → مطابق، هر ۴ ABI موجود

## تست‌نشده (سیاست sandbox)

`expo prebuild` و `gradlew` در این محیط اجرا نمی‌شوند (ساخت اپ موبایل مسدود است). پس مرحله‌ی Gradle «تست‌شده» حساب نمی‌شود.
