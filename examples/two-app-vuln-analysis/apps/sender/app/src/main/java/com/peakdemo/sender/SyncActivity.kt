package com.peakdemo.sender

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class SyncActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val token = getSharedPreferences("auth", MODE_PRIVATE)
            .getString("token", "") ?: ""
        val update = Intent("com.peakdemo.AUTH_TOKEN")
            .putExtra("token", token)
        sendBroadcast(update)
    }
}
