// crypto-hook.js — Hook Java-layer crypto APIs; capture algorithm, key, plaintext, ciphertext.
// Usage: frida -U -f com.target.app -l crypto-hook.js --no-pause
//        frida -H host.docker.internal:14725 -f com.target.app -l crypto-hook.js --no-pause

Java.perform(function () {
    var Cipher = Java.use("javax.crypto.Cipher");
    var SecretKeySpec = Java.use("javax.crypto.spec.SecretKeySpec");
    var IvParameterSpec = Java.use("javax.crypto.spec.IvParameterSpec");
    var MessageDigest = Java.use("java.security.MessageDigest");
    var Mac = Java.use("javax.crypto.Mac");

    // ========== Cipher.getInstance ==========
    Cipher.init.overload("int", "java.security.Key").implementation = function (opmode, key) {
        var mode = opmode === 1 ? "ENCRYPT" : opmode === 2 ? "DECRYPT" : String(opmode);
        var algo = this.getAlgorithm();
        var keyBytes = key.getEncoded();
        console.log("[Cipher.init] mode=" + mode + " algo=" + algo);
        if (keyBytes !== null) {
            console.log("[Cipher.init] key=" + bytesToHex(keyBytes));
            console.log("[Cipher.init] key(b64)=" + bytesToB64(keyBytes));
        }
        return this.init(opmode, key);
    };

    Cipher.init.overload("int", "java.security.Key", "java.security.spec.AlgorithmParameterSpec").implementation = function (opmode, key, params) {
        var mode = opmode === 1 ? "ENCRYPT" : opmode === 2 ? "DECRYPT" : String(opmode);
        var algo = this.getAlgorithm();
        var keyBytes = key.getEncoded();
        console.log("[Cipher.init+params] mode=" + mode + " algo=" + algo);
        if (keyBytes !== null) {
            console.log("[Cipher.init+params] key=" + bytesToHex(keyBytes));
        }
        if (params !== null && params.$className === "javax.crypto.spec.IvParameterSpec") {
            var iv = Java.cast(params, IvParameterSpec);
            var ivBytes = iv.getIV();
            console.log("[Cipher.init+params] iv=" + bytesToHex(ivBytes));
        }
        return this.init(opmode, key, params);
    };

    // ========== Cipher.doFinal ==========
    Cipher.doFinal.overload("[B").implementation = function (input) {
        var algo = this.getAlgorithm();
        console.log("[Cipher.doFinal] algo=" + algo + " input_len=" + input.length);
        console.log("[Cipher.doFinal] input(hex)=" + bytesToHex(input.slice(0, 128)));
        var result = this.doFinal(input);
        if (result !== null) {
            console.log("[Cipher.doFinal] output(hex)=" + bytesToHex(result.slice(0, 128)));
            console.log("[Cipher.doFinal] output_len=" + result.length);
        }
        console.log("[Cipher.doFinal] stack=" + Java.use("android.util.Log").getStackTraceString(Java.use("java.lang.Throwable").$new()));
        return result;
    };

    // ========== SecretKeySpec ==========
    SecretKeySpec.$init.overload("[B", "java.lang.String").implementation = function (keyBytes, algorithm) {
        console.log("[SecretKeySpec] algo=" + algorithm + " key=" + bytesToHex(keyBytes));
        console.log("[SecretKeySpec] key(b64)=" + bytesToB64(keyBytes));
        console.log("[SecretKeySpec] stack=" + Java.use("android.util.Log").getStackTraceString(Java.use("java.lang.Throwable").$new()));
        return this.$init(keyBytes, algorithm);
    };

    // ========== MessageDigest ==========
    MessageDigest.update.overload("[B").implementation = function (input) {
        var algo = this.getAlgorithm();
        console.log("[MessageDigest.update] algo=" + algo + " input=" + bytesToHex(input));
        return this.update(input);
    };

    MessageDigest.digest.overload().implementation = function () {
        var algo = this.getAlgorithm();
        var result = this.digest();
        console.log("[MessageDigest.digest] algo=" + algo + " hash=" + bytesToHex(result));
        return result;
    };

    // ========== Mac ==========
    Mac.init.overload("java.security.Key").implementation = function (key) {
        var algo = this.getAlgorithm();
        var keyBytes = key.getEncoded();
        console.log("[Mac.init] algo=" + algo + " key=" + bytesToHex(keyBytes));
        return this.init(key);
    };

    Mac.doFinal.overload("[B").implementation = function (input) {
        var algo = this.getAlgorithm();
        var result = this.doFinal(input);
        console.log("[Mac.doFinal] algo=" + algo + " input=" + bytesToHex(input) + " hmac=" + bytesToHex(result));
        return result;
    };

    console.log("[*] Crypto hooks installed. Waiting for crypto operations...");
});

function bytesToHex(bytes) {
    if (bytes === null || bytes === undefined) return "(null)";
    var hex = "";
    for (var i = 0; i < bytes.length && i < 256; i++) {
        var b = (bytes[i] & 0xFF).toString(16);
        hex += (b.length === 1 ? "0" + b : b);
    }
    if (bytes.length > 256) hex += "...(truncated)";
    return hex;
}

function bytesToB64(bytes) {
    if (bytes === null || bytes === undefined) return "(null)";
    return Java.use("android.util.Base64").encodeToString(bytes, 0);
}
