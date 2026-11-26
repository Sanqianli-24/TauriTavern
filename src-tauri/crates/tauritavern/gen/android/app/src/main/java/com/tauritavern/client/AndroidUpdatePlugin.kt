package com.tauritavern.client

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class AndroidUpdatePlugin(private val activity: Activity) : Plugin(activity) {
    private val packageManager get() = activity.packageManager
    private val updateApk get() = File(activity.cacheDir, "updates/update.apk")

    @Command
    fun install(invoke: Invoke) {
        try {
            verifyUpdate(invoke.getArgs().getString("version"))
        } catch (error: Exception) {
            invoke.reject("Android could not verify the update package", error)
            return
        }

        activity.runOnUiThread {
            try {
                if (packageManager.canRequestPackageInstalls()) {
                    openInstaller(invoke)
                } else {
                    val settings = Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.fromParts("package", activity.packageName, null),
                    )
                    startActivityForResult(invoke, settings, "afterPermission")
                }
            } catch (error: Exception) {
                invoke.reject("Android could not open the update installer", error)
            }
        }
    }

    @ActivityCallback
    private fun afterPermission(invoke: Invoke, result: ActivityResult) {
        try {
            // The Settings activity's result code does not report this permission.
            if (packageManager.canRequestPackageInstalls()) {
                openInstaller(invoke)
            } else {
                invoke.resolveObject("permission_required")
            }
        } catch (error: Exception) {
            invoke.reject("Android could not open the update installer", error)
        }
    }

    private fun openInstaller(invoke: Invoke) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", updateApk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.startActivity(intent)
        invoke.resolveObject("installer_opened")
    }

    @Suppress("DEPRECATION")
    private fun verifyUpdate(version: String) {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        val archive = requireNotNull(packageManager.getPackageArchiveInfo(updateApk.path, flags))
        val installed = packageManager.getPackageInfo(activity.packageName, flags)
        require(archive.packageName == installed.packageName && archive.versionName == version)
        require(PackageInfoCompat.getLongVersionCode(archive) > PackageInfoCompat.getLongVersionCode(installed))
        val installedSigners = signers(installed)
        require(installedSigners.isNotEmpty() && signers(archive) == installedSigners)
    }

    @Suppress("DEPRECATION")
    private fun signers(pkg: PackageInfo) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        pkg.signingInfo?.apkContentsSigners.orEmpty().toSet()
    } else {
        pkg.signatures.orEmpty().toSet()
    }
}
