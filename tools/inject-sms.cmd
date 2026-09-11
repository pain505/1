@echo off
rem 往模拟器收件箱塞几条取件短信，用于验证 App 的解析与展示。
rem 用法： tools\inject-sms.cmd
setlocal
set ADB=%~dp0..\.android-toolchain\sdk\platform-tools\adb.exe
set PKG=com.pickupcode.app

echo [1/4] 授权
%ADB% shell pm grant %PKG% android.permission.READ_SMS
%ADB% shell pm grant %PKG% android.permission.RECEIVE_SMS
%ADB% shell pm grant %PKG% android.permission.POST_NOTIFICATIONS

echo [2/4] 插入测试短信
%ADB% shell content insert --uri content://sms/inbox --bind address:s:10690123456789 --bind body:s:"【菜鸟驿站】您的包裹已到菜鸟驿站(阳光花园店)，取件码 8-3-2015，请凭码取件，请24小时内取件" --bind read:i:1
%ADB% shell content insert --uri content://sms/inbox --bind address:s:10690333445566 --bind body:s:"【丰巢】凭22-2-3579到华润万家旁丰巢柜取件" --bind read:i:1
%ADB% shell content insert --uri content://sms/inbox --bind address:s:10690555667788 --bind body:s:"【菜鸟驿站】您有2个包裹已到菜鸟驿站(万达广场店)，取件码为16-4-9626, 15-3-2194，请凭码取件" --bind read:i:1
%ADB% shell content insert --uri content://sms/inbox --bind address:s:10690999887766 --bind body:s:"【中邮驿站】您的邮政包裹已到，取件码A88123，请及时领取" --bind read:i:1

echo [3/4] 确认写入
%ADB% shell content query --uri content://sms/inbox --projection body

echo [4/4] 重启 App
%ADB% shell am force-stop %PKG%
%ADB% logcat -c
%ADB% shell am start -n %PKG%/.ui.MainActivity
endlocal
