package com.peakdemo.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class TokenReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val token = intent.getStringExtra("token") ?: return
        context.getSharedPreferences("inbox", Context.MODE_PRIVATE)
            .edit().putString("last_token", token).apply()
    }
}
