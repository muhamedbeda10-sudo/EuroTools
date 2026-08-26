@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   اعداد نظام فحص الجودة (اول مرة فقط)
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [خطأ] Node.js غير مثبت على هذا الجهاز.
  echo ثبّت Node.js LTS من https://nodejs.org ثم شغّل هذا الملف مرة اخرى.
  pause
  exit /b 1
)

echo [1/5] تثبيت الحزم...
call npm install
if errorlevel 1 ( echo فشل التثبيت & pause & exit /b 1 )

echo [2/5] توليد Prisma Client...
call npx prisma generate
if errorlevel 1 ( echo فشل توليد Prisma & pause & exit /b 1 )

echo [3/5] تجهيز قاعدة البيانات...
call npx prisma migrate deploy
if errorlevel 1 ( echo فشل تجهيز قاعدة البيانات & pause & exit /b 1 )

echo [4/5] بناء نسخة الانتاج...
call npm run build
if errorlevel 1 ( echo فشل البناء & pause & exit /b 1 )

echo.
echo [5/5] بيانات تجريبية (اختياري)
echo هل تريد تحميل بيانات تجريبية لتجربة كل المراحل؟
echo تحذير: هذا يمسح اي بيانات موجودة في قاعدة البيانات.
choice /c YN /n /m "اضغط Y للتحميل او N للتخطي: "
if errorlevel 2 goto :skipseed
call npm run seed
:skipseed

echo.
echo ============================================
echo   تم الاعداد بنجاح. شغّل التطبيق عبر run.bat
echo ============================================
pause
