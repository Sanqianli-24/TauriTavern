let listener;

export function observeCloudSyncChanges(onChange) {
    listener = onChange;
}

export function markCloudSyncDirty() {
    listener?.();
}
