package com.example.vuln

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.webkit.WebView

class DeepLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val target = intent?.data?.getQueryParameter("url") ?: return
        if (!isTrusted(Uri.parse(target))) return

        val webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.addJavascriptInterface(TokenBridge(this), "PeakToken")
        setContentView(webView)
        webView.loadUrl(target)
    }

    private fun isTrusted(uri: Uri): Boolean {
        return uri.scheme == "https" && (uri.host?.endsWith("example.com") == true)
    }
}
