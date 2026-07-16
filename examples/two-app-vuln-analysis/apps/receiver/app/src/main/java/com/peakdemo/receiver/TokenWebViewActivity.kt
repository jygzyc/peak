package com.peakdemo.receiver

import android.app.Activity
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView

class TokenWebViewActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val view = WebView(this)
        view.settings.javaScriptEnabled = true
        view.addJavascriptInterface(this, "ReceiverToken")
        setContentView(view)
        view.loadUrl(intent.getStringExtra("url") ?: "about:blank")
    }

    @JavascriptInterface
    fun lastToken(): String = getSharedPreferences("inbox", MODE_PRIVATE)
        .getString("last_token", "") ?: ""
}
