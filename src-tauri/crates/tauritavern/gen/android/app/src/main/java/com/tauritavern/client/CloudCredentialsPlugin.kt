package com.tauritavern.client

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class CloudCredentialArgs {
  lateinit var value: String
}

@TauriPlugin
class CloudCredentialsPlugin(activity: Activity) : Plugin(activity) {
  private val storage = File(activity.noBackupFilesDir, "cloud-sync")
  private val file = AtomicFile(File(storage, "credentials.v1"))
  private val alias = "tauritavern-cloud-sync-v1"

  @Command
  fun storageDirectory(invoke: Invoke) = respond(invoke) {
    JSObject().apply { put("path", File(storage, "data").absolutePath) }
  }

  @Command
  fun load(invoke: Invoke) = respond(invoke) {
    val result = JSObject()
    val sealed = try {
      file.readFully()
    } catch (_: FileNotFoundException) {
      return@respond result
    }
    require(sealed.size >= 28)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, checkNotNull(keyStore().getKey(alias, null)), GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
    val plaintext = cipher.doFinal(sealed, 12, sealed.size - 12)
    try {
      result.put("value", plaintext.toString(Charsets.UTF_8))
    } finally {
      plaintext.fill(0)
    }
    result
  }

  @Command
  fun save(invoke: Invoke) = respond(invoke) {
    val keyStore = keyStore()
    val existing = keyStore.getKey(alias, null) as? SecretKey
    val key = existing ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
      generateKey()
    }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    require(cipher.iv.size == 12)
    val bytes = invoke.parseArgs(CloudCredentialArgs::class.java).value.toByteArray(Charsets.UTF_8)
    val sealed = try {
      cipher.iv + cipher.doFinal(bytes)
    } finally {
      bytes.fill(0)
    }
    val pending = file.startWrite()
    try {
      pending.write(sealed)
      file.finishWrite(pending)
    } catch (error: Exception) {
      file.failWrite(pending)
      throw error
    }
    null
  }

  @Command
  fun clear(invoke: Invoke) = respond(invoke) {
    file.delete()
    keyStore().deleteEntry(alias)
    null
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  @Synchronized
  private fun respond(invoke: Invoke, operation: () -> JSObject?) {
    try {
      val result = operation()
      if (result == null) invoke.resolve() else invoke.resolve(result)
    } catch (_: Exception) {
      invoke.reject("Cloud sync credentials are unavailable")
    }
  }
}
