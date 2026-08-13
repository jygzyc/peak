// ssl-pinning-bypass.js — Generic SSL pinning bypass (TrustManager / OkHttp / WebView / NetworkSecurityConfig).
// Usage: frida -U -f com.target.app -l ssl-pinning-bypass.js --no-pause

Java.perform(function () {

    // ========== TrustManager ==========
    try {
        var X509TrustManager = Java.use("javax.net.ssl.X509TrustManager");
        var SSLContext = Java.use("javax.net.ssl.SSLContext");
        var TrustManager = Java.registerClass({
            name: "com.peak.TrustManager",
            implements: [X509TrustManager],
            methods: {
                checkClientTrusted: function (chain, authType) { },
                checkServerTrusted: function (chain, authType) { },
                getAcceptedIssuers: function () { return []; }
            }
        });
        SSLContext.init.overload("[Ljavax.net.ssl.TrustManager;", "[Ljavax.net.ssl.KeyManager;", "java.security.SecureRandom").implementation = function (tm, km, sr) {
            console.log("[SSL] SSLContext.init called, replacing TrustManager");
            this.init([TrustManager.$new()], km, sr);
        };
        console.log("[*] TrustManager bypass installed");
    } catch (e) {
        console.log("[!] TrustManager bypass failed: " + e);
    }

    // ========== OkHttp CertificatePinner ==========
    try {
        var CertificatePinner = Java.use("okhttp3.CertificatePinner");
        CertificatePinner.check.overload("java.lang.String", "java.util.List").implementation = function (hostname, peerCertificates) {
            console.log("[SSL] OkHttp CertificatePinner.check bypassed for: " + hostname);
        };
        console.log("[*] OkHttp CertificatePinner bypass installed");
    } catch (e) {
        console.log("[!] OkHttp CertificatePinner not found (okhttp3 not in classpath)");
    }

    // ========== WebView ClientCertificateRequest ==========
    try {
        var ClientCertificateRequest = Java.use("android.webkit.ClientCertificateRequest");
        ClientCertificateRequest.proceed.implementation = function () {
            console.log("[SSL] WebView ClientCertificateRequest.proceed called");
            return this.proceed();
        };
    } catch (e) { }

    // ========== NetworkSecurityConfig (Android 7+) ==========
    try {
        var NetworkSecurityConfig = Java.use("android.security.net.config.NetworkSecurityConfig");
        if (NetworkSecurityConfig.isCleartextTrafficPermitted) {
            NetworkSecurityConfig.isCleartextTrafficPermitted.implementation = function () {
                return true;
            };
        }
    } catch (e) { }

    console.log("[*] SSL Pinning bypass hooks installed. Monitoring network traffic...");
});
