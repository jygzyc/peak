// root-bypass.js — Generic root-detection bypass.
// Usage: frida -U -f com.target.app -l root-bypass.js --no-pause

Java.perform(function () {

    // ========== File.exists — block su/SuperSU detection ==========
    var File = Java.use("java.io.File");
    File.exists.implementation = function () {
        var path = this.getAbsolutePath();
        var deny = [
            "/system/app/Superuser.apk", "/system/app/SuperSU", "/system/bin/su",
            "/system/xbin/su", "/sbin/su", "/data/local/bin/su", "/data/local/xbin/su",
            "/system/sd/xbin/su", "/system/bin/failsafe/su", "/data/local/su",
            "/su/bin", "/magisk", "/system/app/Magisk", "/sbin/.magisk"
        ];
        for (var i = 0; i < deny.length; i++) {
            if (path.indexOf(deny[i]) >= 0) {
                console.log("[Root] File.exists blocked: " + path);
                return false;
            }
        }
        return this.exists();
    };

    // ========== Runtime.exec — block `which su` ==========
    var Runtime = Java.use("java.lang.Runtime");
    Runtime.exec.overload("java.lang.String").implementation = function (cmd) {
        if (cmd.indexOf("su") >= 0 || cmd.indexOf("which su") >= 0) {
            console.log("[Root] Runtime.exec blocked: " + cmd);
            throw Java.use("java.io.IOException").$new("Permission denied");
        }
        return this.exec(cmd);
    };

    // ========== PackageManager — block magisk/supersu app detection ==========
    try {
        var PackageManager = Java.use("android.app.ApplicationPackageManager");
        PackageManager.getPackageInfo.overload("java.lang.String", "int").implementation = function (name, flags) {
            var rootApps = [
                "com.topjohnwu.magisk", "eu.chainfire.supersu", "com.noshufou.android.su",
                "com.koushikdutta.superuser", "com.thirdparty.superuser", "com.yellowes.su",
                "com.noshufou.android.su.elite", "io.va.exposed", "org.lsposed.safemode"
            ];
            for (var i = 0; i < rootApps.length; i++) {
                if (name === rootApps[i]) {
                    console.log("[Root] PackageManager.getPackageInfo blocked: " + name);
                    throw Java.use("android.content.pm.PackageManager$NameNotFoundException").$new(name);
                }
            }
            return this.getPackageInfo(name, flags);
        };
    } catch (e) {
        console.log("[!] PackageManager hook failed: " + e);
    }

    // ========== Settings.Secure — block dev-mode detection ==========
    try {
        var Settings = Java.use("android.provider.Settings$Secure");
        Settings.getString.implementation = function (resolver, name) {
            if (name === "adb_enabled") {
                console.log("[Root] Settings.Secure.adb_enabled => false");
                return "0";
            }
            return this.getString(resolver, name);
        };
    } catch (e) { }

    // ========== Build.TAGS — block test-keys detection ==========
    try {
        var Build = Java.use("android.os.Build");
        Build.TAGS.value = "release-keys";
    } catch (e) { }

    console.log("[*] Root detection bypass hooks installed");
});
