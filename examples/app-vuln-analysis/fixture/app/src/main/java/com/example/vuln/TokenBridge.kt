package com.example.vuln

import android.content.Context
import android.webkit.JavascriptInterface

class TokenBridge(private val context: Context) {
    @JavascriptInterface
    fun readAuthToken(): String {
        return context.getSharedPreferences("auth", Context.MODE_PRIVATE)
            .getString("token", "") ?: ""
    }
}
